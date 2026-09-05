"""
Phase 2 backend tests: Invoices + Money Receipts + files + stats.sales-today.by_source
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/") or "https://mass-dialer-2.preview.emergentagent.com"
API = f"{BASE_URL}/api"
ADMIN = ("admin", "Admin@2026")
EMP = ("emp1", "Emp@2026")


def _login(u, p):
    r = requests.post(f"{API}/auth/login", json={"username": u, "password": p}, timeout=30)
    assert r.status_code == 200, f"login failed: {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_token():
    return _login(*ADMIN)


@pytest.fixture(scope="module")
def emp_token():
    return _login(*EMP)


def H(tok):
    return {"Authorization": f"Bearer {tok}"}


# ---------- Invoices ----------
class TestInvoices:
    created_ids = []

    def test_create_invoice_employee(self, emp_token):
        payload = {
            "customer_name": "TEST_Ravi Sharma",
            "customer_mobile": "919876543210",
            "customer_address": "Test lane, Blr",
            "items": [
                {"name": "Cabinet A", "qty": 2, "unit_price": 1500},
                {"name": "Cabinet B", "qty": 1, "unit_price": 500},
            ],
            "notes": "TEST invoice",
        }
        r = requests.post(f"{API}/invoices", json=payload, headers=H(emp_token), timeout=60)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["invoice_no"].startswith("INV-") and len(d["invoice_no"]) == 10
        assert d["customer_name"] == "TEST_Ravi Sharma"
        assert d["total"] == 3500.0
        assert d["subtotal"] == 3500.0
        assert d["sale_id"]
        assert d["pdf_path"] and d["pdf_token"]
        assert len(d["items"]) == 2
        assert d["items"][0]["amount"] == 3000.0
        TestInvoices.created_ids.append(d["id"])
        # save for later
        TestInvoices.first_inv = d

    def test_invoice_creates_linked_sale(self, emp_token):
        inv = TestInvoices.first_inv
        r = requests.get(f"{API}/sales", headers=H(emp_token), timeout=30)
        assert r.status_code == 200
        sales = r.json()
        match = [s for s in sales if s.get("id") == inv["sale_id"]]
        assert match, "linked sale not present in GET /sales"
        s = match[0]
        assert s["source"] == "invoice"
        assert s["invoice_id"] == inv["id"]
        assert s["invoice_no"] == inv["invoice_no"]
        assert abs(s["amount"] - inv["total"]) < 0.001

    def test_list_invoices_workspace(self, admin_token):
        r = requests.get(f"{API}/invoices?limit=200", headers=H(admin_token), timeout=30)
        assert r.status_code == 200
        arr = r.json()
        ids = [x["id"] for x in arr]
        assert TestInvoices.first_inv["id"] in ids
        # newest first — created invoice should be near top
        assert ids[0] == TestInvoices.first_inv["id"] or TestInvoices.first_inv["id"] in ids[:5]
        # all have fresh pdf_token
        for x in arr[:3]:
            assert x.get("pdf_token")

    def test_get_invoice_by_id(self, admin_token):
        iid = TestInvoices.first_inv["id"]
        r = requests.get(f"{API}/invoices/{iid}", headers=H(admin_token), timeout=30)
        assert r.status_code == 200
        d = r.json()
        assert d["id"] == iid
        assert d["pdf_token"]

    def test_invoice_validation_empty_name(self, emp_token):
        r = requests.post(f"{API}/invoices", json={
            "customer_name": "  ", "customer_mobile": "919", "items": [{"name": "x", "qty": 1, "unit_price": 10}],
        }, headers=H(emp_token), timeout=30)
        assert r.status_code == 400

    def test_invoice_validation_no_items(self, emp_token):
        r = requests.post(f"{API}/invoices", json={
            "customer_name": "TEST_X", "customer_mobile": "919", "items": [],
        }, headers=H(emp_token), timeout=30)
        assert r.status_code == 400

    def test_invoice_validation_zero_qty(self, emp_token):
        r = requests.post(f"{API}/invoices", json={
            "customer_name": "TEST_X", "customer_mobile": "919",
            "items": [{"name": "x", "qty": 0, "unit_price": 10}],
        }, headers=H(emp_token), timeout=30)
        assert r.status_code == 400

    def test_pdf_download_with_token(self, emp_token):
        inv = TestInvoices.first_inv
        url = f"{API}/files/{inv['pdf_path']}?token={inv['pdf_token']}"
        r = requests.get(url, timeout=60)
        assert r.status_code == 200, r.text
        assert r.headers.get("content-type", "").startswith("application/pdf")
        assert r.content.startswith(b"%PDF")

    def test_pdf_403_wrong_token(self, emp_token):
        inv = TestInvoices.first_inv
        # generate a token for a different path via /files/token
        r = requests.get(f"{API}/files/token?path=some/other/path.pdf", headers=H(emp_token), timeout=30)
        assert r.status_code == 200
        bad_tok = r.json()["token"]
        url = f"{API}/files/{inv['pdf_path']}?token={bad_tok}"
        r2 = requests.get(url, timeout=30)
        assert r2.status_code == 403

    def test_pdf_401_no_auth(self):
        inv = TestInvoices.first_inv
        url = f"{API}/files/{inv['pdf_path']}"
        r = requests.get(url, timeout=30)
        assert r.status_code == 401

    def test_stats_sales_today_by_source(self, admin_token):
        r = requests.get(f"{API}/stats/sales-today", headers=H(admin_token), timeout=30)
        assert r.status_code == 200
        d = r.json()
        assert "by_source" in d
        assert "invoice" in d["by_source"]
        assert d["by_source"]["invoice"]["count"] >= 1
        assert d["by_source"]["invoice"]["revenue"] >= 3500.0

    def test_invoice_delete_employee_forbidden(self, emp_token):
        iid = TestInvoices.first_inv["id"]
        r = requests.delete(f"{API}/invoices/{iid}", headers=H(emp_token), timeout=30)
        assert r.status_code == 403


# ---------- Receipts ----------
class TestReceipts:
    def test_create_receipt_with_invoice_source(self, emp_token, admin_token):
        # create invoice first to use as source
        inv_payload = {
            "customer_name": "TEST_RcptSrc", "customer_mobile": "911111111111",
            "items": [{"name": "Sofa", "qty": 1, "unit_price": 12000}],
        }
        r = requests.post(f"{API}/invoices", json=inv_payload, headers=H(emp_token), timeout=60)
        assert r.status_code == 200
        inv = r.json()
        TestReceipts.src_inv = inv

        payload = {
            "customer_name": "TEST_RcptSrc",
            "customer_mobile": "911111111111",
            "amount": 5000,
            "payment_mode": "online",
            "source_type": "invoice",
            "source_id": inv["id"],
            "narration": "Advance for sofa delivery",
            "notes": "TEST receipt",
        }
        r = requests.post(f"{API}/receipts", json=payload, headers=H(emp_token), timeout=60)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["receipt_no"].startswith("RCPT-")
        assert d["amount"] == 5000
        assert d["payment_mode"] == "online"
        assert d["source_type"] == "invoice"
        assert d["source_label"] and inv["invoice_no"] in d["source_label"]
        assert d["narration"] == "Advance for sofa delivery"
        assert d["pdf_path"] and d["pdf_token"]
        TestReceipts.first = d

    def test_receipt_pdf_downloads(self):
        d = TestReceipts.first
        url = f"{API}/files/{d['pdf_path']}?token={d['pdf_token']}"
        r = requests.get(url, timeout=60)
        assert r.status_code == 200
        assert r.content.startswith(b"%PDF")

    def test_receipt_validation_bad_mode(self, emp_token):
        r = requests.post(f"{API}/receipts", json={
            "customer_name": "TEST_X", "amount": 100,
            "payment_mode": "bitcoin", "source_type": "other",
        }, headers=H(emp_token), timeout=30)
        assert r.status_code == 400

    def test_receipt_validation_bad_source_type(self, emp_token):
        r = requests.post(f"{API}/receipts", json={
            "customer_name": "TEST_X", "amount": 100,
            "payment_mode": "cash", "source_type": "wat",
        }, headers=H(emp_token), timeout=30)
        assert r.status_code == 400

    def test_receipt_validation_negative_amount(self, emp_token):
        r = requests.post(f"{API}/receipts", json={
            "customer_name": "TEST_X", "amount": -1,
            "payment_mode": "cash", "source_type": "other",
        }, headers=H(emp_token), timeout=30)
        assert r.status_code == 400

    def test_list_receipts(self, admin_token):
        r = requests.get(f"{API}/receipts?limit=200", headers=H(admin_token), timeout=30)
        assert r.status_code == 200
        arr = r.json()
        ids = [x["id"] for x in arr]
        assert TestReceipts.first["id"] in ids

    def test_get_receipt_by_id(self, admin_token):
        rid = TestReceipts.first["id"]
        r = requests.get(f"{API}/receipts/{rid}", headers=H(admin_token), timeout=30)
        assert r.status_code == 200
        assert r.json()["id"] == rid
        assert r.json()["pdf_token"]

    def test_receipt_delete_employee_forbidden(self, emp_token):
        rid = TestReceipts.first["id"]
        r = requests.delete(f"{API}/receipts/{rid}", headers=H(emp_token), timeout=30)
        assert r.status_code == 403


# ---------- Cleanup + delete-cascade ----------
class TestCleanup:
    def test_admin_delete_invoice_cascades_sale(self, admin_token):
        inv = TestInvoices.first_inv
        # delete invoice
        r = requests.delete(f"{API}/invoices/{inv['id']}", headers=H(admin_token), timeout=30)
        assert r.status_code == 200
        assert r.json().get("deleted") is True
        # linked sale must be gone
        r2 = requests.get(f"{API}/sales", headers=H(admin_token), timeout=30)
        assert r2.status_code == 200
        assert not any(s.get("id") == inv["sale_id"] for s in r2.json())
        # invoice gone
        r3 = requests.get(f"{API}/invoices/{inv['id']}", headers=H(admin_token), timeout=30)
        assert r3.status_code == 404

    def test_admin_delete_receipt(self, admin_token):
        rid = TestReceipts.first["id"]
        r = requests.delete(f"{API}/receipts/{rid}", headers=H(admin_token), timeout=30)
        assert r.status_code == 200
        r2 = requests.get(f"{API}/receipts/{rid}", headers=H(admin_token), timeout=30)
        assert r2.status_code == 404

    def test_cleanup_source_invoice(self, admin_token):
        # delete the receipt-source invoice we created too
        inv = TestReceipts.src_inv
        r = requests.delete(f"{API}/invoices/{inv['id']}", headers=H(admin_token), timeout=30)
        assert r.status_code == 200


# ---------- Regression: existing endpoints still up ----------
class TestRegression:
    @pytest.mark.parametrize("path", [
        "/auth/me", "/customers?scope=mine", "/sales", "/stats/today",
        "/stats/leaderboard", "/daybook", "/settings", "/followups",
    ])
    def test_endpoint_ok(self, admin_token, path):
        r = requests.get(f"{API}{path}", headers=H(admin_token), timeout=30)
        assert r.status_code == 200, f"{path} -> {r.status_code}: {r.text[:200]}"
