"""
Iteration 20 backend tests
==========================
BUG FIX regression + new feature verification:

1. POST /api/invoices MUST NOT auto-create a sale record anymore.
   - Sales count for the acting user unchanged after invoice creation.
   - response.sale_id is null.
   - GET /api/sales does not include invoice items as a sale row.

2. Invoice cash+online split:
   - explicit split -> response has cash_amount, online_amount, payment_mode='mixed'
   - default (no split) -> cash=total, online=0, payment_mode='cash'
   - mismatch cash+online != total -> 400
   - cash-only / online-only variants -> correct payment_mode

3. GET /api/invoices returns cash_amount, online_amount, payment_mode +
   linked_receipts populated when receipts with source_type='invoice' exist.

4. Customer ledger correctness:
   - 1 manual sale ₹1000 + 1 invoice ₹2000 + 1 receipt ₹500
   - summary.total_billed_manual=1000, summary.total_invoices=2000,
     summary.total_received=500, summary.due_balance=2500.

5. Sales POST supports cash+online split too.

6. attach_receipt_ids still links advance receipts to the invoice.
"""
import os
import uuid
import pytest
import requests

BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
    or ""
).rstrip("/")
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL must be set"

API = f"{BASE_URL}/api"
ADMIN = ("admin", "Admin@2026")
EMP = ("emp1", "Emp@2026")
PHONE_PREFIX = "91TEST20"


def _login(user, pw):
    r = requests.post(f"{API}/auth/login", json={"username": user, "password": pw}, timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_token():
    return _login(*ADMIN)


@pytest.fixture(scope="module")
def H(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


_state = {"receipts": [], "invoices": [], "sales": [], "customers": []}


def _fresh_phone(tag: str) -> str:
    n = uuid.uuid4().hex[:6]
    return f"{PHONE_PREFIX}{tag}{n}"[:15]


def _sales_count(H, user="admin"):
    r = requests.get(f"{API}/sales", params={"scope": "mine", "days": 365}, headers=H, timeout=30)
    assert r.status_code == 200, r.text
    return len(r.json()), r.json()


def _make_invoice(H, **overrides):
    body = {
        "customer_name": overrides.pop("customer_name", "TEST20 Cust"),
        "customer_mobile": overrides.pop("customer_mobile", _fresh_phone("I")),
        "customer_address": "n/a",
        "items": overrides.pop("items", [{"name": "Widget", "qty": 1, "unit_price": 5000}]),
        "notes": "iter20",
    }
    body.update(overrides)
    r = requests.post(f"{API}/invoices", json=body, headers=H, timeout=30)
    return r, body


def _make_receipt(H, **overrides):
    body = {
        "customer_name": overrides.pop("customer_name", "TEST20 Cust"),
        "customer_mobile": overrides.pop("customer_mobile", _fresh_phone("R")),
        "amount": 100.0,
        "payment_mode": "cash",
        "source_type": "other",
        "narration": "iter20",
    }
    body.update(overrides)
    r = requests.post(f"{API}/receipts", json=body, headers=H, timeout=30)
    assert r.status_code == 200, f"receipt failed: {r.status_code} {r.text}"
    d = r.json()
    _state["receipts"].append(d["id"])
    return d


# ============================================================
# 1) REGRESSION: Invoice does NOT create a sale
# ============================================================
class TestInvoiceDoesNotCreateSale:
    def test_invoice_creation_does_not_touch_sales(self, H):
        before_count, before = _sales_count(H)
        r, body = _make_invoice(H, customer_mobile=_fresh_phone("N"))
        assert r.status_code == 200, r.text
        inv = r.json()
        _state["invoices"].append(inv["id"])

        # (d) invoice document is created
        assert inv["id"] and inv["invoice_no"], "invoice not created"
        assert inv["total"] == 5000.0
        # (e) sale_id null
        assert inv.get("sale_id") is None, f"sale_id should be null, got {inv.get('sale_id')!r}"

        after_count, after = _sales_count(H)
        # (a),(c) sales count unchanged for this user
        assert after_count == before_count, (
            f"sales count changed: before={before_count} after={after_count}; "
            f"new sales: {[s for s in after if s['id'] not in {x['id'] for x in before}]}"
        )

    def test_get_sales_does_not_include_invoice_items(self, H):
        phone = _fresh_phone("Q")
        r, _ = _make_invoice(H, customer_mobile=phone, customer_name="TEST20 X",
                             items=[{"name": "UniqueXYZ_iter20", "qty": 2, "unit_price": 250}])
        assert r.status_code == 200, r.text
        inv = r.json()
        _state["invoices"].append(inv["id"])

        s_resp = requests.get(f"{API}/sales", params={"scope": "mine", "days": 365}, headers=H, timeout=30)
        assert s_resp.status_code == 200
        sales = s_resp.json()
        # No sale should reference this invoice
        for s in sales:
            assert s.get("invoice_id") != inv["id"], f"leaked sale for invoice: {s}"
            assert s.get("invoice_no") != inv["invoice_no"], f"leaked sale for invoice_no: {s}"
            assert (s.get("source") or "manual") != "invoice" or s.get("invoice_id") != inv["id"]


# ============================================================
# 2) Invoice cash / online split validation
# ============================================================
class TestInvoiceSplit:
    def test_mixed_split_ok(self, H):
        r, _ = _make_invoice(
            H, customer_mobile=_fresh_phone("M"),
            cash_amount=3000, online_amount=2000,
            items=[{"name": "SplitItem", "qty": 1, "unit_price": 5000}],
        )
        assert r.status_code == 200, r.text
        inv = r.json()
        _state["invoices"].append(inv["id"])
        assert inv["cash_amount"] == 3000.0
        assert inv["online_amount"] == 2000.0
        assert inv["payment_mode"] == "mixed"
        assert inv["total"] == 5000.0

    def test_default_no_split_is_cash(self, H):
        r, _ = _make_invoice(H, customer_mobile=_fresh_phone("D"))
        assert r.status_code == 200, r.text
        inv = r.json()
        _state["invoices"].append(inv["id"])
        assert inv["cash_amount"] == inv["total"] == 5000.0
        assert inv["online_amount"] == 0.0
        assert inv["payment_mode"] == "cash"

    def test_mismatch_split_400(self, H):
        r, _ = _make_invoice(
            H, customer_mobile=_fresh_phone("E"),
            cash_amount=2000, online_amount=2000,
            items=[{"name": "MismatchItem", "qty": 1, "unit_price": 5000}],
        )
        assert r.status_code == 400, f"expected 400, got {r.status_code} {r.text}"

    def test_cash_only_split(self, H):
        r, _ = _make_invoice(
            H, customer_mobile=_fresh_phone("CO"),
            cash_amount=5000, online_amount=0,
            items=[{"name": "AllCash", "qty": 1, "unit_price": 5000}],
        )
        assert r.status_code == 200, r.text
        inv = r.json()
        _state["invoices"].append(inv["id"])
        assert inv["cash_amount"] == 5000.0
        assert inv["online_amount"] == 0.0
        assert inv["payment_mode"] == "cash"

    def test_online_only_split(self, H):
        r, _ = _make_invoice(
            H, customer_mobile=_fresh_phone("OL"),
            cash_amount=0, online_amount=5000,
            items=[{"name": "AllOnline", "qty": 1, "unit_price": 5000}],
        )
        assert r.status_code == 200, r.text
        inv = r.json()
        _state["invoices"].append(inv["id"])
        assert inv["cash_amount"] == 0.0
        assert inv["online_amount"] == 5000.0
        assert inv["payment_mode"] == "online"


# ============================================================
# 3) GET /api/invoices returns new fields + linked_receipts
# ============================================================
class TestListInvoicesFields:
    def test_list_returns_split_fields_and_linked_receipts(self, H):
        phone = _fresh_phone("LR")
        # Advance receipt first (source_type='other')
        adv = _make_receipt(H, customer_mobile=phone, amount=800, source_type="other")
        assert adv["reference_no"] == ""

        r, _ = _make_invoice(
            H, customer_mobile=phone, customer_name="TEST20 LR",
            cash_amount=1000, online_amount=4000,
            items=[{"name": "LRitem", "qty": 1, "unit_price": 5000}],
            attach_receipt_ids=[adv["id"]],
        )
        assert r.status_code == 200, r.text
        inv = r.json()
        _state["invoices"].append(inv["id"])

        lst = requests.get(f"{API}/invoices", params={"limit": 200}, headers=H, timeout=30)
        assert lst.status_code == 200, lst.text
        rows = lst.json()
        found = next((x for x in rows if x["id"] == inv["id"]), None)
        assert found, "created invoice not in list"
        assert "cash_amount" in found and "online_amount" in found and "payment_mode" in found
        assert found["cash_amount"] == 1000.0
        assert found["online_amount"] == 4000.0
        assert found["payment_mode"] == "mixed"
        assert "linked_receipts" in found, "linked_receipts field missing"
        linked_ids = [lr.get("id") for lr in found["linked_receipts"]]
        assert adv["id"] in linked_ids, f"attached receipt not returned in linked_receipts: {found['linked_receipts']}"


# ============================================================
# 4) Customer ledger correctness
# ============================================================
class TestCustomerLedger:
    def test_ledger_totals(self, H):
        phone = _fresh_phone("LG")
        # 1. Create customer via manual sale (auto-link)
        # First: create customer explicitly for stable id
        cbody = {"name": "TEST20 Ledger", "phone": phone, "notes": "iter20"}
        cr = requests.post(f"{API}/customers", json=cbody, headers=H, timeout=30)
        assert cr.status_code == 200, cr.text
        cust = cr.json()
        _state["customers"].append(cust["id"])
        cid = cust["id"]

        # Manual sale ₹1000
        sr = requests.post(
            f"{API}/sales",
            json={
                "customer_id": cid,
                "customer_name": "TEST20 Ledger",
                "amount": 1000,
                "payment_mode": "cash",
                "product": "manual-thing",
            },
            headers=H, timeout=30,
        )
        assert sr.status_code == 200, sr.text
        _state["sales"].append(sr.json()["id"])

        # Invoice ₹2000
        ir, _ = _make_invoice(
            H, customer_mobile=phone, customer_name="TEST20 Ledger",
            customer_id=cid,
            items=[{"name": "invitem", "qty": 1, "unit_price": 2000}],
        )
        assert ir.status_code == 200, ir.text
        inv = ir.json()
        _state["invoices"].append(inv["id"])

        # Receipt ₹500
        rc_r = requests.post(
            f"{API}/receipts",
            json={
                "customer_id": cid,
                "customer_name": "TEST20 Ledger",
                "customer_mobile": phone,
                "amount": 500,
                "payment_mode": "cash",
                "source_type": "other",
                "narration": "iter20 rc",
            },
            headers=H, timeout=30,
        )
        assert rc_r.status_code == 200, rc_r.text
        _state["receipts"].append(rc_r.json()["id"])

        # Fetch ledger
        lg = requests.get(f"{API}/customers/{cid}/ledger", headers=H, timeout=30)
        assert lg.status_code == 200, lg.text
        summary = lg.json()["summary"]
        assert summary["total_billed_manual"] == 1000.0, summary
        assert summary["total_invoices"] == 2000.0, summary
        assert summary["total_received"] == 500.0, summary
        assert summary["due_balance"] == 2500.0, summary

        # Timeline should show sale + invoice as SEPARATE entries
        kinds = [t["kind"] for t in lg.json()["timeline"]]
        assert kinds.count("sale") >= 1, kinds
        assert kinds.count("invoice") >= 1, kinds


# ============================================================
# 5) Sales POST supports cash+online split
# ============================================================
class TestSalesSplit:
    def test_sales_mixed_split(self, H):
        r = requests.post(
            f"{API}/sales",
            json={
                "customer_name": "TEST20 SaleSplit",
                "amount": 1500,
                "cash_amount": 1000,
                "online_amount": 500,
                "product": "iter20-split",
            },
            headers=H, timeout=30,
        )
        assert r.status_code == 200, r.text
        s = r.json()
        _state["sales"].append(s["id"])
        assert s["cash_amount"] == 1000.0
        assert s["online_amount"] == 500.0
        assert s["payment_mode"] == "mixed"
        assert s["amount"] == 1500.0

    def test_sales_default_is_cash(self, H):
        r = requests.post(
            f"{API}/sales",
            json={
                "customer_name": "TEST20 SaleDefault",
                "amount": 1500,
                "product": "iter20-default",
            },
            headers=H, timeout=30,
        )
        assert r.status_code == 200, r.text
        s = r.json()
        _state["sales"].append(s["id"])
        assert s["cash_amount"] == 1500.0
        assert s["online_amount"] == 0.0
        assert s["payment_mode"] == "cash"


# ============================================================
# 6) attach_receipt_ids still works
# ============================================================
class TestAttachReceipts:
    def test_attach_links_receipt_to_invoice(self, H):
        phone = _fresh_phone("AT")
        adv = _make_receipt(H, customer_mobile=phone, amount=250, source_type="other")

        r, _ = _make_invoice(
            H, customer_mobile=phone, customer_name="TEST20 Attach",
            items=[{"name": "AttachItem", "qty": 1, "unit_price": 5000}],
            attach_receipt_ids=[adv["id"]],
        )
        assert r.status_code == 200, r.text
        inv = r.json()
        _state["invoices"].append(inv["id"])

        # Reload receipt
        g = requests.get(f"{API}/receipts/{adv['id']}", headers=H, timeout=30)
        assert g.status_code == 200, g.text
        upd = g.json()
        assert upd["source_type"] == "invoice"
        assert upd["source_id"] == inv["id"]
        assert upd["reference_no"] == inv["invoice_no"]


# ============================================================
# CLEANUP
# ============================================================
@pytest.fixture(scope="module", autouse=True)
def _cleanup(admin_token):
    yield
    H = {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}
    for rid in _state["receipts"]:
        try:
            requests.delete(f"{API}/receipts/{rid}", headers=H, timeout=15)
        except Exception:
            pass
    for iid in _state["invoices"]:
        try:
            requests.delete(f"{API}/invoices/{iid}", headers=H, timeout=15)
        except Exception:
            pass
    for sid in _state["sales"]:
        try:
            requests.delete(f"{API}/sales/{sid}", headers=H, timeout=15)
        except Exception:
            pass
    # Clean TEST20 customers
    try:
        r = requests.get(f"{API}/customers", params={"scope": "all", "search": PHONE_PREFIX},
                         headers=H, timeout=30)
        if r.status_code == 200:
            for c in r.json():
                if PHONE_PREFIX in (c.get("phone") or ""):
                    try:
                        requests.delete(f"{API}/customers/{c['id']}", headers=H, timeout=15)
                    except Exception:
                        pass
    except Exception:
        pass
