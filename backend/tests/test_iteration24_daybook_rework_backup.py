"""Iteration 24 backend tests — Pritha Cabinet CRM new features.

Covers:
- Auth for admin / emp1 (collector) / emp2 (plain employee)
- /api/daybook (admin+collector; forbidden for plain employee) and structure
- Cash verification (PUT/DELETE, upsert, ACL)
- Daybook photos (POST with APP_NAME prefix guard, DELETE ACL)
- Media token endpoint (/api/media/{token})
- Admin PUT /api/invoices/{id} + PUT /api/receipts/{id}
- GET /api/receipts/source/{type}/{id}
- Admin backup token + backup.json + backup.xlsx
- Daybook export-token + daybook.xlsx
- Sales visible scope=all default and scope=mine
- Customer ledger totals + sale timeline receipts
"""
import os
import io
import json
import base64
import pytest
import requests
from pathlib import Path

# Read backend URL from frontend/.env
_ENV = Path("/app/frontend/.env").read_text().splitlines()
BASE_URL = None
for line in _ENV:
    if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
        BASE_URL = line.split("=", 1)[1].strip().strip('"').rstrip("/")
        break
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL missing"
API = f"{BASE_URL}/api"
TODAY = __import__("datetime").datetime.utcnow().strftime("%Y-%m-%d")


def _login(username, password):
    r = requests.post(f"{API}/auth/login", json={"username": username, "password": password}, timeout=30)
    assert r.status_code == 200, f"login {username}: {r.status_code} {r.text}"
    return r.json()["access_token"], r.json()["user"]


@pytest.fixture(scope="module")
def admin():
    tok, u = _login("admin", "Admin@2026")
    return {"tok": tok, "user": u, "h": {"Authorization": f"Bearer {tok}"}}


@pytest.fixture(scope="module")
def emp1():
    tok, u = _login("emp1", "Emp@2026")
    return {"tok": tok, "user": u, "h": {"Authorization": f"Bearer {tok}"}}


@pytest.fixture(scope="module")
def emp2():
    tok, u = _login("emp2", "Emp@2026")
    return {"tok": tok, "user": u, "h": {"Authorization": f"Bearer {tok}"}}


# ---------- Auth ----------
class TestAuth:
    def test_admin_login(self, admin):
        assert admin["user"]["role"] == "admin"

    def test_emp1_login(self, emp1):
        assert emp1["user"]["role"] == "employee"
        assert emp1["user"]["username"] == "emp1"

    def test_emp2_login(self, emp2):
        assert emp2["user"]["role"] == "employee"

    def test_collector_is_emp1(self, admin):
        r = requests.get(f"{API}/collector", headers=admin["h"], timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        # If emp1 is not the assigned collector yet, assign it (for repeatable tests).
        if not data.get("collector") or data["collector"]["username"] != "emp1":
            assign = requests.put(f"{API}/admin/collector", json={"username": "emp1"}, headers=admin["h"], timeout=15)
            assert assign.status_code == 200, assign.text
            data = assign.json()
        assert data["collector"]["username"] == "emp1", data


# ---------- Daybook read ----------
class TestDaybookRead:
    def test_admin_can_read(self, admin):
        r = requests.get(f"{API}/daybook", params={"date": TODAY}, headers=admin["h"], timeout=30)
        assert r.status_code == 200, r.text
        db = r.json()
        # Required keys per spec
        for k in ("sales", "invoices", "due_collection", "receipts", "standalone_receipts",
                  "grand_total", "expected_cash", "cash_verification", "photos", "reconciliation",
                  "total_collection"):
            assert k in db, f"missing key {k}"
        # reconciliation shape
        rec = db["reconciliation"]
        for k in ("verified", "match", "expected_cash", "counted_cash", "variance_total",
                  "denominations", "note", "verified_by", "verified_by_name", "verified_at"):
            assert k in rec, f"reconciliation missing {k}"
        # total_collection
        assert "cash_in_hand" in db["total_collection"]
        # photos is list
        assert isinstance(db["photos"], list)
        # Each receipt entry has counted_standalone bool
        for r_ in db["receipts"]["entries"]:
            assert isinstance(r_.get("counted_standalone"), bool), "counted_standalone missing/bad on receipt"

    def test_collector_can_read(self, emp1):
        r = requests.get(f"{API}/daybook", params={"date": TODAY}, headers=emp1["h"], timeout=30)
        assert r.status_code == 200, r.text

    def test_plain_employee_forbidden(self, emp2):
        r = requests.get(f"{API}/daybook", params={"date": TODAY}, headers=emp2["h"], timeout=15)
        assert r.status_code == 403


# ---------- Cash verification ----------
class TestCashVerification:
    DATE = "2026-01-05"

    def test_admin_saves_verification(self, admin):
        body = {"date_key": self.DATE, "denominations": {"500": 2, "100": 3}, "note": "test-verify"}
        r = requests.put(f"{API}/daybook/cash-verification", json=body, headers=admin["h"], timeout=30)
        assert r.status_code == 200, r.text
        db = r.json()
        assert db["reconciliation"]["verified"] is True
        assert db["reconciliation"]["counted_cash"] == 1300
        # Save again (upsert, still ONE record)
        r2 = requests.put(f"{API}/daybook/cash-verification", json=body, headers=admin["h"], timeout=30)
        assert r2.status_code == 200
        # Direct DB check indirect: only one cash_verifications for that date — reflect via read
        rd = requests.get(f"{API}/daybook", params={"date": self.DATE}, headers=admin["h"], timeout=15)
        assert rd.status_code == 200
        assert rd.json()["reconciliation"]["counted_cash"] == 1300

    def test_collector_can_save(self, emp1):
        body = {"date_key": self.DATE, "denominations": {"200": 1}, "note": "collector-save"}
        r = requests.put(f"{API}/daybook/cash-verification", json=body, headers=emp1["h"], timeout=30)
        assert r.status_code == 200, r.text
        assert r.json()["reconciliation"]["counted_cash"] == 200

    def test_plain_employee_forbidden_save(self, emp2):
        body = {"date_key": self.DATE, "denominations": {"100": 1}, "note": "x"}
        r = requests.put(f"{API}/daybook/cash-verification", json=body, headers=emp2["h"], timeout=15)
        assert r.status_code == 403

    def test_delete_collector_forbidden(self, emp1):
        r = requests.delete(f"{API}/daybook/cash-verification", params={"date": self.DATE},
                            headers=emp1["h"], timeout=15)
        assert r.status_code == 403

    def test_delete_admin_ok(self, admin):
        r = requests.delete(f"{API}/daybook/cash-verification", params={"date": self.DATE},
                            headers=admin["h"], timeout=15)
        assert r.status_code == 200
        # Now verification should be gone
        rd = requests.get(f"{API}/daybook", params={"date": self.DATE}, headers=admin["h"], timeout=15)
        assert rd.json()["reconciliation"]["verified"] is False


# ---------- Daybook photos ----------
_MIN_JPG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwc"
    "KDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy"
    "MjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUAQEA"
    "AAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEB"
    "AAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAA"
    "AAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAA"
    "ABCf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB/"
    "/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k="
)


class TestPhotos:
    def test_upload_and_add_photo(self, admin):
        # upload small jpg
        files = {"file": ("tiny.jpg", _MIN_JPG, "image/jpeg")}
        up = requests.post(f"{API}/files/upload", headers=admin["h"], files=files, timeout=30)
        assert up.status_code == 200, up.text
        path = up.json()["path"]
        assert path.startswith("callflow-crm/")
        # Add to daybook photos
        r = requests.post(f"{API}/daybook/photos",
                          json={"date_key": TODAY, "path": path, "caption": "TEST_cash_desk"},
                          headers=admin["h"], timeout=15)
        assert r.status_code == 200, r.text
        pid = r.json()["id"]
        # verify daybook GET includes it (token + display_name)
        db = requests.get(f"{API}/daybook", params={"date": TODAY}, headers=admin["h"], timeout=15).json()
        matching = [p for p in db["photos"] if p["id"] == pid]
        assert matching, "photo not in daybook"
        assert matching[0].get("token")
        assert matching[0].get("display_name")
        TestPhotos._pid = pid
        TestPhotos._token = matching[0]["token"]
        TestPhotos._path = path

    def test_invalid_path_400(self, admin):
        r = requests.post(f"{API}/daybook/photos",
                          json={"date_key": TODAY, "path": "wrongprefix/foo.jpg", "caption": ""},
                          headers=admin["h"], timeout=15)
        assert r.status_code == 400

    def test_media_token_serves_pdf(self, admin):
        # Grab a receipt or invoice with pdf_token first — create an invoice
        inv = requests.post(f"{API}/invoices", json={
            "customer_name": "ZZTEST_media_cust", "customer_mobile": "9990001234",
            "items": [{"name": "ZZTEST_item", "qty": 1, "unit_price": 100}],
            "cash_amount": 100, "online_amount": 0
        }, headers=admin["h"], timeout=30)
        assert inv.status_code == 200, inv.text
        pdf_token = inv.json()["pdf_token"]
        assert pdf_token
        r = requests.get(f"{API}/media/{pdf_token}", timeout=30)
        assert r.status_code == 200
        assert r.headers["content-type"] == "application/pdf"
        assert r.content[:4] == b"%PDF"
        # bad token
        bad = requests.get(f"{API}/media/not-a-token", timeout=10)
        assert bad.status_code == 401
        # cleanup
        iid = inv.json()["id"]
        d = requests.delete(f"{API}/invoices/{iid}", headers=admin["h"], timeout=15)
        assert d.status_code == 200

    def test_emp2_cannot_delete_photo(self, emp2):
        r = requests.delete(f"{API}/daybook/photos/{TestPhotos._pid}", headers=emp2["h"], timeout=15)
        assert r.status_code == 403

    def test_admin_delete_photo(self, admin):
        r = requests.delete(f"{API}/daybook/photos/{TestPhotos._pid}", headers=admin["h"], timeout=15)
        assert r.status_code == 200


# ---------- Invoice PUT (admin edit) ----------
class TestInvoiceEdit:
    def test_full_edit_and_regen(self, admin, emp1):
        # create
        cr = requests.post(f"{API}/invoices", json={
            "customer_name": "ZZTEST_inv_cust", "customer_mobile": "9998877665",
            "items": [{"name": "ZZTEST_A", "qty": 2, "unit_price": 50}],
            "cash_amount": 100, "online_amount": 0
        }, headers=admin["h"], timeout=30)
        assert cr.status_code == 200
        iid = cr.json()["id"]

        # PUT with modified items + mixed
        upd = requests.put(f"{API}/invoices/{iid}", json={
            "customer_name": "ZZTEST_inv_cust_edited", "customer_mobile": "9998877665",
            "customer_address": "TEST_addr",
            "items": [
                {"name": "ZZTEST_B", "qty": 3, "unit_price": 100},
                {"name": "ZZTEST_C", "qty": 1, "unit_price": 50},
            ],
            "cash_amount": 200, "online_amount": 150, "date_key": TODAY
        }, headers=admin["h"], timeout=30)
        assert upd.status_code == 200, upd.text
        j = upd.json()
        assert j["total"] == 350.0
        assert j["payment_mode"] == "mixed"
        assert j["pdf_token"]

        # mismatch cash+online != total => 400
        bad = requests.put(f"{API}/invoices/{iid}", json={
            "customer_name": "x", "customer_mobile": "9998877665",
            "items": [{"name": "y", "qty": 1, "unit_price": 100}],
            "cash_amount": 30, "online_amount": 20
        }, headers=admin["h"], timeout=15)
        assert bad.status_code == 400

        # emp1 (collector) cannot PUT
        forb = requests.put(f"{API}/invoices/{iid}", json={
            "customer_name": "x", "customer_mobile": "9998877665",
            "items": [{"name": "y", "qty": 1, "unit_price": 100}]
        }, headers=emp1["h"], timeout=15)
        assert forb.status_code == 403

        TestInvoiceEdit._iid = iid
        TestInvoiceEdit._inv_no = j["invoice_no"]


# ---------- Receipt PUT + source ----------
class TestReceiptEdit:
    def test_source_lookup_and_edit(self, admin, emp2):
        iid = TestInvoiceEdit._iid
        inv_no = TestInvoiceEdit._inv_no

        # source lookup
        sr = requests.get(f"{API}/receipts/source/invoice/{iid}", headers=admin["h"], timeout=15)
        assert sr.status_code == 200
        info = sr.json()
        assert info["customer_name"]
        assert info["amount"] > 0
        assert "remaining" in info and "reference_no" in info

        # bad source_type
        bad_st = requests.get(f"{API}/receipts/source/nope/{iid}", headers=admin["h"], timeout=10)
        assert bad_st.status_code == 400
        # unknown id
        bad_id = requests.get(f"{API}/receipts/source/invoice/nonexistent-xyz", headers=admin["h"], timeout=10)
        assert bad_id.status_code == 404

        # Create receipt linked to invoice
        cr = requests.post(f"{API}/receipts", json={
            "customer_name": info["customer_name"],
            "customer_mobile": info["customer_mobile"],
            "amount": 100, "payment_mode": "cash",
            "source_type": "invoice", "source_id": iid,
        }, headers=admin["h"], timeout=30)
        assert cr.status_code == 200, cr.text
        rid = cr.json()["id"]
        rcpt_no = cr.json()["receipt_no"]

        # PUT change amount + payment_mode mixed
        put = requests.put(f"{API}/receipts/{rid}", json={
            "customer_name": "ZZTEST_rcpt_edited",
            "customer_mobile": info["customer_mobile"],
            "amount": 300, "payment_mode": "mixed",
            "cash_amount": 200, "online_amount": 100,
            "source_type": "invoice", "source_id": iid,
        }, headers=admin["h"], timeout=30)
        assert put.status_code == 200, put.text
        j = put.json()
        assert j["receipt_no"] == rcpt_no
        assert j["reference_no"] == inv_no
        assert j["payment_mode"] == "mixed"
        assert j["amount"] == 300.0

        # mismatch => 400
        mm = requests.put(f"{API}/receipts/{rid}", json={
            "customer_name": "x", "customer_mobile": "1",
            "amount": 100, "payment_mode": "mixed",
            "cash_amount": 60, "online_amount": 60,
            "source_type": "other",
        }, headers=admin["h"], timeout=15)
        assert mm.status_code == 400

        # emp2 forbidden
        forb = requests.put(f"{API}/receipts/{rid}", json={
            "customer_name": "x", "customer_mobile": "1",
            "amount": 100, "payment_mode": "cash",
        }, headers=emp2["h"], timeout=15)
        assert forb.status_code == 403

        # cleanup receipt + invoice
        drc = requests.delete(f"{API}/receipts/{rid}", headers=admin["h"], timeout=15)
        assert drc.status_code == 200
        di = requests.delete(f"{API}/invoices/{TestInvoiceEdit._iid}", headers=admin["h"], timeout=15)
        assert di.status_code == 200


# ---------- Admin backup ----------
class TestBackup:
    def test_emp_no_token(self, emp2):
        r = requests.get(f"{API}/admin/backup/token", headers=emp2["h"], timeout=15)
        assert r.status_code == 403

    def test_admin_token_and_json(self, admin):
        tk = requests.get(f"{API}/admin/backup/token", headers=admin["h"], timeout=15)
        assert tk.status_code == 200
        token = tk.json()["token"]
        # bad token
        bad = requests.get(f"{API}/admin/backup.json", params={"token": "abc.def.ghi"}, timeout=15)
        assert bad.status_code == 401
        # good token JSON
        j = requests.get(f"{API}/admin/backup.json", params={"token": token}, timeout=60)
        assert j.status_code == 200
        assert "application/json" in j.headers["content-type"]
        payload = j.json()
        assert "counts" in payload and "collections" in payload
        for k in ("users", "customers", "sales", "invoices", "receipts", "collections",
                  "cash_verifications", "daybook_photos", "attendance"):
            assert k in payload["collections"], f"missing {k}"
        # xlsx
        x = requests.get(f"{API}/admin/backup.xlsx", params={"token": token}, timeout=60)
        assert x.status_code == 200
        assert x.headers.get("content-type", "").startswith("application/vnd.openxmlformats"), x.headers
        assert x.content[:2] == b"PK"


# ---------- Daybook Excel export ----------
class TestDaybookExport:
    def test_emp2_no_token(self, emp2):
        r = requests.get(f"{API}/daybook/export-token", params={"from": TODAY}, headers=emp2["h"], timeout=15)
        assert r.status_code == 403

    def test_admin_export(self, admin):
        tk = requests.get(f"{API}/daybook/export-token", params={"from": TODAY}, headers=admin["h"], timeout=15)
        assert tk.status_code == 200
        token = tk.json()["token"]
        x = requests.get(f"{API}/daybook.xlsx", params={"token": token}, timeout=60)
        assert x.status_code == 200
        assert x.content[:2] == b"PK"

    def test_collector_export(self, emp1):
        tk = requests.get(f"{API}/daybook/export-token", params={"from": TODAY}, headers=emp1["h"], timeout=15)
        assert tk.status_code == 200


# ---------- Sales scope ----------
class TestSalesScope:
    def test_default_all(self, emp2, admin):
        # Seed a sale from admin so emp2 can see it
        cr = requests.post(f"{API}/sales", json={
            "customer_name": "ZZTEST_sale_cust", "customer_mobile": "9990000123",
            "amount": 100, "cash_amount": 100, "online_amount": 0
        }, headers=admin["h"], timeout=30)
        assert cr.status_code == 200
        sid = cr.json()["id"]

        r_all = requests.get(f"{API}/sales", headers=emp2["h"], timeout=30)
        assert r_all.status_code == 200
        owners = {s["user"] for s in r_all.json()}
        assert "admin" in owners, "scope=all default did not include admin's sale"

        r_mine = requests.get(f"{API}/sales", params={"scope": "mine"}, headers=emp2["h"], timeout=30)
        assert r_mine.status_code == 200
        mine_owners = {s["user"] for s in r_mine.json()}
        assert mine_owners <= {"emp2"}, f"scope=mine included others: {mine_owners}"

        # stats today
        st = requests.get(f"{API}/stats/sales-today", params={"scope": "all"}, headers=emp2["h"], timeout=15)
        assert st.status_code == 200
        st2 = requests.get(f"{API}/stats/sales-today", params={"scope": "mine"}, headers=emp2["h"], timeout=15)
        assert st2.status_code == 200

        # cleanup
        requests.delete(f"{API}/sales/{sid}", headers=admin["h"], timeout=15)


# ---------- Customer ledger ----------
class TestLedger:
    def test_ledger_totals_and_receipts(self, admin):
        # Create customer, sale, receipt — use unique phone to avoid re-run collision
        import time as _t
        uniq_phone = f"9{int(_t.time()) % 1000000000:09d}"
        cust = requests.post(f"{API}/customers", json={"name": "ZZTEST_led_cust", "phone": uniq_phone},
                             headers=admin["h"], timeout=15)
        assert cust.status_code == 200, cust.text
        cid = cust.json()["id"]
        # Manual sale (daily) — actually just use /sales
        s = requests.post(f"{API}/sales", json={
            "customer_id": cid, "customer_name": "ZZTEST_led_cust", "customer_mobile": uniq_phone,
            "amount": 500, "cash_amount": 500, "online_amount": 0
        }, headers=admin["h"], timeout=30)
        assert s.status_code == 200
        sid = s.json()["id"]
        # Receipt linked to sale
        rcpt = requests.post(f"{API}/receipts", json={
            "customer_id": cid, "customer_name": "ZZTEST_led_cust", "customer_mobile": uniq_phone,
            "amount": 100, "payment_mode": "cash",
            "source_type": "sale", "source_id": sid,
        }, headers=admin["h"], timeout=30)
        assert rcpt.status_code == 200
        rid = rcpt.json()["id"]

        led = requests.get(f"{API}/customers/{cid}/ledger", headers=admin["h"], timeout=30)
        assert led.status_code == 200, led.text
        j = led.json()
        summary = j["summary"]
        expected_total = summary.get("total_billed_manual", 0) + summary.get("total_invoices", 0)
        assert abs(summary["total_billed"] - expected_total) < 0.01, (summary, expected_total)
        # timeline: find sale event with receipts[] containing pdf_token
        sale_events = [e for e in j.get("timeline", []) if e.get("kind") == "sale" and e.get("id") == sid]
        assert sale_events, "sale not in timeline"
        recs = sale_events[0].get("receipts") or []
        assert any(r.get("pdf_token") for r in recs), "sale timeline missing pdf_token on linked receipt"

        # cleanup
        requests.delete(f"{API}/receipts/{rid}", headers=admin["h"], timeout=15)
        requests.delete(f"{API}/sales/{sid}", headers=admin["h"], timeout=15)
        requests.delete(f"{API}/customers/{cid}", headers=admin["h"], timeout=15)
