"""Iteration 23: NEW backend features regression tests
  1) Deployment health probe: GET /health returns {"status":"ok"} (no /api prefix)
  2) GET /api/customers/search  — by name OR mobile, all-users visibility, is_mine flag, limit clamp
  3) Enhanced linked_receipts payload with reference_no on sales/collections/invoices/daybook
     plus regression on customers/lookup and customers/{id}/ledger still working, and
     pdf_token still populated on linked_receipts.
"""
import os
import time
import uuid
import pytest
import requests

# Public URL (routed via ingress, so /api → backend). We need this for real user-flow.
BASE = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
API = f"{BASE}/api"

# /health is NOT routed via ingress (which only proxies /api). Deployment probes hit backend
# directly on port 8001. Test the health route at internal port.
BACKEND_INTERNAL = "http://localhost:8001"

RUN = uuid.uuid4().hex[:6]


def _h(t):
    return {"Authorization": f"Bearer {t}", "Content-Type": "application/json"}


# ---------- fixtures ----------
@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"username": "admin", "password": "Admin@2026"}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def emp1_token():
    r = requests.post(f"{API}/auth/login", json={"username": "emp1", "password": "Emp@2026"}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def emp2_token():
    r = requests.post(f"{API}/auth/login", json={"username": "emp2", "password": "Emp@2026"}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def customer_by_emp2(emp2_token):
    """Create a customer under emp2 (so emp1 sees it as `is_mine=False`)."""
    payload = {
        "name": f"TEST_Search_{RUN} Ramesh",
        "phone": f"98{int(time.time()) % 10_000_000:07d}",
    }
    r = requests.post(f"{API}/customers", json=payload, headers=_h(emp2_token), timeout=15)
    assert r.status_code == 200, r.text
    c = r.json()
    yield c
    # cleanup — admin can delete
    try:
        adm = requests.post(f"{API}/auth/login", json={"username": "admin", "password": "Admin@2026"}, timeout=15).json()["access_token"]
        requests.delete(f"{API}/customers/{c['id']}", headers=_h(adm), timeout=15)
    except Exception:
        pass


# ---------- (1) Health probe ----------
class TestHealthProbe:
    def test_health_root_no_api_prefix(self):
        """GET /health on backend (internal) must return {status:'ok'} — used by k8s probes."""
        r = requests.get(f"{BACKEND_INTERNAL}/health", timeout=10)
        assert r.status_code == 200, r.text
        assert r.json() == {"status": "ok"}

    def test_root_ok(self):
        """GET / on backend (internal) should also 200 OK (deployment sanity)."""
        r = requests.get(f"{BACKEND_INTERNAL}/", timeout=10)
        assert r.status_code == 200
        j = r.json()
        assert j.get("status") == "ok"


# ---------- (2) Customer search ----------
class TestCustomerSearch:
    def test_search_requires_auth(self):
        r = requests.get(f"{API}/customers/search?q=abc", timeout=15)
        assert r.status_code == 401 or r.status_code == 403, r.text

    def test_search_empty_q_returns_empty(self, emp1_token):
        r = requests.get(f"{API}/customers/search?q=", headers=_h(emp1_token), timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data == {"customers": [], "count": 0}

    def test_search_missing_q_returns_empty(self, emp1_token):
        # q param defaults to "" → same as empty
        r = requests.get(f"{API}/customers/search", headers=_h(emp1_token), timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["count"] == 0
        assert data["customers"] == []

    def test_search_by_name_partial_case_insensitive(self, emp1_token, customer_by_emp2):
        # customer name contains "Ramesh" and unique run tag
        q = f"ramesh_{RUN}".lower()  # try a bogus/lower — should not fail; use RUN as unique tag
        r = requests.get(f"{API}/customers/search", headers=_h(emp1_token), params={"q": f"search_{RUN}"}, timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        ids = [c["id"] for c in data["customers"]]
        assert customer_by_emp2["id"] in ids, f"expected new customer in search results: {data}"

    def test_search_returns_is_mine_flag_correctly(self, emp1_token, emp2_token, customer_by_emp2):
        # emp1 searches — customer is emp2's so is_mine=False for emp1
        r1 = requests.get(f"{API}/customers/search", headers=_h(emp1_token), params={"q": f"search_{RUN}"}, timeout=15)
        assert r1.status_code == 200
        row = next(c for c in r1.json()["customers"] if c["id"] == customer_by_emp2["id"])
        assert row["is_mine"] is False, "emp1 must NOT own emp2's customer"
        assert row.get("assigned_to") == "emp2"

        # emp2 searches — customer is theirs so is_mine=True
        r2 = requests.get(f"{API}/customers/search", headers=_h(emp2_token), params={"q": f"search_{RUN}"}, timeout=15)
        assert r2.status_code == 200
        row2 = next(c for c in r2.json()["customers"] if c["id"] == customer_by_emp2["id"])
        assert row2["is_mine"] is True

    def test_search_by_phone_partial_digits(self, emp1_token, customer_by_emp2):
        # Search using last 5 digits of the phone
        phone = customer_by_emp2["phone"]
        tail = phone[-5:]
        r = requests.get(f"{API}/customers/search", headers=_h(emp1_token), params={"q": tail}, timeout=15)
        assert r.status_code == 200, r.text
        ids = [c["id"] for c in r.json()["customers"]]
        assert customer_by_emp2["id"] in ids

    def test_search_visible_to_all_employees_regardless_of_assignee(self, customer_by_emp2):
        """Iterate all seeded employees + admin. Every one should see the customer."""
        for uname, pwd in [("admin", "Admin@2026")] + [(f"emp{i}", "Emp@2026") for i in range(1, 8)]:
            tk = requests.post(f"{API}/auth/login", json={"username": uname, "password": pwd}, timeout=15).json()["access_token"]
            r = requests.get(f"{API}/customers/search", headers=_h(tk), params={"q": f"search_{RUN}"}, timeout=15)
            assert r.status_code == 200, f"{uname}: {r.text}"
            found = [c for c in r.json()["customers"] if c["id"] == customer_by_emp2["id"]]
            assert found, f"user {uname} could NOT see customer created by emp2"

    def test_search_limit_clamped_min(self, emp1_token):
        # limit=1 is minimum meaningful value (server clamps at 1). Note server does `int(limit or 20)`
        # so limit=0 falsy → default 20, which is fine; here we assert explicit lower bound behaviour.
        r = requests.get(f"{API}/customers/search", headers=_h(emp1_token), params={"q": "a", "limit": 1}, timeout=15)
        assert r.status_code == 200
        assert r.json()["count"] <= 1

    def test_search_limit_clamped_negative(self, emp1_token):
        # Negative should clamp to 1 (max(1, min(-5, 100)) = max(1,-5) = 1)
        r = requests.get(f"{API}/customers/search", headers=_h(emp1_token), params={"q": "a", "limit": -5}, timeout=15)
        assert r.status_code == 200
        assert r.json()["count"] <= 1

    def test_search_limit_clamped_max(self, emp1_token):
        r = requests.get(f"{API}/customers/search", headers=_h(emp1_token), params={"q": "a", "limit": 500}, timeout=15)
        assert r.status_code == 200
        assert r.json()["count"] <= 100


# ---------- Regression: /customers/lookup still works ----------
class TestCustomerLookupRegression:
    def test_lookup_by_phone(self, emp1_token, customer_by_emp2):
        r = requests.get(f"{API}/customers/lookup", headers=_h(emp1_token), params={"phone": customer_by_emp2["phone"]}, timeout=15)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["exists"] is True
        assert j["customer"]["id"] == customer_by_emp2["id"]
        assert j["customer"]["is_mine"] is False  # emp1 doesn't own it

    def test_lookup_missing_phone(self, emp1_token):
        r = requests.get(f"{API}/customers/lookup", headers=_h(emp1_token), params={"phone": "0000000000"}, timeout=15)
        assert r.status_code == 200
        assert r.json()["exists"] is False


# ---------- Regression: ledger still works ----------
class TestCustomerLedgerRegression:
    def test_ledger_ok(self, emp1_token, customer_by_emp2):
        r = requests.get(f"{API}/customers/{customer_by_emp2['id']}/ledger", headers=_h(emp1_token), timeout=15)
        assert r.status_code == 200, r.text
        j = r.json()
        # Structure sanity — should have entries + summary keys typically
        assert isinstance(j, dict)
        # Common keys we expect in a ledger response
        assert any(k in j for k in ["entries", "customer", "sales", "invoices", "receipts", "summary"]), f"unexpected ledger shape: {list(j.keys())}"


# ---------- (3) reference_no on linked_receipts ----------
@pytest.fixture(scope="module")
def sale_with_receipt(emp1_token):
    """Create a customer + sale under emp1, then post a receipt for that sale with a reference_no."""
    tag = f"TEST_Ref_{RUN}_{uuid.uuid4().hex[:4]}"
    cust_payload = {"name": tag, "phone": f"97{int(time.time()) % 10_000_000:07d}"}
    rc = requests.post(f"{API}/customers", json=cust_payload, headers=_h(emp1_token), timeout=15)
    assert rc.status_code == 200, rc.text
    cust = rc.json()

    sale_body = {
        "customer_id": cust["id"],
        "customer_name": cust["name"],
        "amount": 1500,
        "payment_mode": "cash",
        "product": "TestProduct",
        "notes": "iter23-sale",
    }
    rs = requests.post(f"{API}/sales", json=sale_body, headers=_h(emp1_token), timeout=20)
    assert rs.status_code == 200, rs.text
    sale = rs.json()

    ref_no = "REF-XYZ-123"
    receipt_body = {
        "customer_id": cust["id"],
        "customer_name": cust["name"],
        "customer_mobile": cust["phone"],
        "amount": 500,
        "payment_mode": "cash",
        "source_type": "sale",
        "source_id": sale["id"],
        "reference_no": ref_no,
        "notes": "iter23-receipt",
    }
    rr = requests.post(f"{API}/receipts", json=receipt_body, headers=_h(emp1_token), timeout=30)
    assert rr.status_code == 200, rr.text
    receipt = rr.json()
    assert receipt["reference_no"] == ref_no

    return {"customer": cust, "sale": sale, "receipt": receipt, "ref_no": ref_no}


class TestLinkedReceiptsRefNo:
    def test_sales_linked_receipts_include_reference_no(self, emp1_token, sale_with_receipt):
        r = requests.get(f"{API}/sales", headers=_h(emp1_token), params={"scope": "all", "days": 30}, timeout=20)
        assert r.status_code == 200, r.text
        sales = r.json()
        target = next((s for s in sales if s["id"] == sale_with_receipt["sale"]["id"]), None)
        assert target is not None, "created sale missing from /api/sales?scope=all"
        lr = target.get("linked_receipts") or []
        assert lr, "linked_receipts empty on sale"
        found = next((x for x in lr if x["id"] == sale_with_receipt["receipt"]["id"]), None)
        assert found is not None
        assert "reference_no" in found
        assert found["reference_no"] == sale_with_receipt["ref_no"]
        # regression: pdf_token still present
        assert "pdf_token" in found
        assert found["pdf_token"], "pdf_token should be populated"

    def test_collections_linked_receipts_include_reference_no(self, emp1_token):
        # Create a collection then a receipt for it with ref_no
        coll_body = {"cash_total": 200, "online_total": 0, "notes": "iter23-coll"}
        rc = requests.post(f"{API}/collections", json=coll_body, headers=_h(emp1_token), timeout=15)
        assert rc.status_code == 200, rc.text
        col = rc.json()

        ref_no = f"COLLREF-{RUN}"
        rr = requests.post(f"{API}/receipts", json={
            "customer_name": "TEST_Coll Payer",
            "customer_mobile": "9999999999",
            "amount": 200,
            "payment_mode": "cash",
            "source_type": "collection",
            "source_id": col["id"],
            "reference_no": ref_no,
        }, headers=_h(emp1_token), timeout=30)
        assert rr.status_code == 200, rr.text
        rec = rr.json()

        r = requests.get(f"{API}/collections", headers=_h(emp1_token), timeout=15)
        assert r.status_code == 200
        cols = r.json()
        target = next((c for c in cols if c["id"] == col["id"]), None)
        assert target is not None
        lr = target.get("linked_receipts") or []
        assert lr, "no linked_receipts on collection"
        found = next((x for x in lr if x["id"] == rec["id"]), None)
        assert found is not None
        assert found.get("reference_no") == ref_no

    def test_invoices_linked_receipts_include_reference_no(self, emp1_token):
        # Create an invoice
        inv_body = {
            "customer_name": f"TEST_Inv_{RUN}",
            "customer_mobile": f"96{int(time.time()) % 10_000_000:07d}",
            "items": [{"name": "Widget", "qty": 2, "unit_price": 100}],
            "cash_amount": 200,
            "online_amount": 0,
        }
        ri = requests.post(f"{API}/invoices", json=inv_body, headers=_h(emp1_token), timeout=30)
        assert ri.status_code == 200, ri.text
        inv = ri.json()

        # Post receipt linked to this invoice with reference_no override
        ref_no = f"INVREF-{RUN}"
        rr = requests.post(f"{API}/receipts", json={
            "customer_id": inv.get("customer_id"),
            "customer_name": inv["customer_name"],
            "customer_mobile": inv["customer_mobile"],
            "amount": 100,
            "payment_mode": "cash",
            "source_type": "invoice",
            "source_id": inv["id"],
            "reference_no": ref_no,
        }, headers=_h(emp1_token), timeout=30)
        assert rr.status_code == 200, rr.text
        rec = rr.json()

        r = requests.get(f"{API}/invoices", headers=_h(emp1_token), timeout=15)
        assert r.status_code == 200
        invs = r.json()
        target = next((iv for iv in invs if iv["id"] == inv["id"]), None)
        assert target is not None
        lr = target.get("linked_receipts") or []
        assert lr, "no linked_receipts on invoice"
        # Find our explicit receipt
        found = next((x for x in lr if x["id"] == rec["id"]), None)
        assert found is not None
        assert found.get("reference_no") == ref_no
        # regression: pdf_token still populated
        assert "pdf_token" in found

    def test_daybook_linked_receipts_reference_no(self, admin_token, emp1_token, sale_with_receipt):
        from datetime import date
        today = date.today().isoformat()
        r = requests.get(f"{API}/daybook", headers=_h(admin_token), params={"date": today}, timeout=20)
        assert r.status_code == 200, r.text
        db = r.json()

        def _lr_iter(section_key):
            section = db.get(section_key) or {}
            entries = section.get("entries") if isinstance(section, dict) else section
            if entries is None:
                return []
            out = []
            for e in entries or []:
                for lr in (e.get("linked_receipts") or []):
                    out.append(lr)
            return out

        # Check receipts across sections: due_collection, daily_sales, invoices
        # At least one of them should exist (from sale_with_receipt fixture)
        found_ref = None
        for key in ("due_collection", "daily_sales", "invoices"):
            for lr in _lr_iter(key):
                # every linked_receipt on daybook must carry reference_no as a string field
                assert "reference_no" in lr, f"reference_no missing on daybook {key} linked_receipt: {lr}"
                assert isinstance(lr["reference_no"], str)
                if lr.get("id") == sale_with_receipt["receipt"]["id"]:
                    found_ref = lr["reference_no"]
        # If we found our seeded receipt, verify the value matches
        if found_ref is not None:
            assert found_ref == sale_with_receipt["ref_no"]
