"""
Iteration 19 backend tests — Reference-number workflow + advance-receipt
attachment at invoice-creation time.

Coverage:
  * POST /api/receipts auto-derives reference_no from source_type/source_id
    (invoice / sale-with-invoice_no / sale-without-invoice_no / collection / other).
  * Explicit reference_no override always wins.
  * GET /api/receipts/advances (phone, customer_id, missing params, filtering).
  * PATCH /api/receipts/{id} (admin only, edit reference_no, auto-derive on
    source change).
  * POST /api/invoices with attach_receipt_ids
    (same customer link, different customer skip, non-advance skip).
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

PHONE_PREFIX = "91TEST19"


# -------------- fixtures & helpers --------------
def _login(user, pw):
    r = requests.post(f"{API}/auth/login", json={"username": user, "password": pw}, timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_token():
    return _login(*ADMIN)


@pytest.fixture(scope="module")
def emp_token():
    return _login(*EMP)


@pytest.fixture(scope="module")
def H(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def HE(emp_token):
    return {"Authorization": f"Bearer {emp_token}", "Content-Type": "application/json"}


_state = {
    "receipts": [],
    "invoices": [],
    "sales": [],
    "phones": set(),
}


def _fresh_phone(tag: str) -> str:
    # 12-digit-ish phone unique per test  (still string; norm_phone will trim leading 91)
    n = uuid.uuid4().hex[:6]
    ph = f"{PHONE_PREFIX}{tag}{n}"[:15]
    _state["phones"].add(ph)
    return ph


def _make_receipt(H, **overrides):
    body = {
        "customer_name": "TEST19 Customer",
        "customer_mobile": overrides.pop("customer_mobile", _fresh_phone("R")),
        "amount": 100.0,
        "payment_mode": "cash",
        "source_type": "other",
        "narration": "iter19 test",
    }
    body.update(overrides)
    r = requests.post(f"{API}/receipts", json=body, headers=H, timeout=30)
    assert r.status_code == 200, f"receipt create failed: {r.status_code} {r.text}"
    doc = r.json()
    _state["receipts"].append(doc["id"])
    return doc


def _make_invoice(H, **overrides):
    body = {
        "customer_name": "TEST19 Customer",
        "customer_mobile": overrides.pop("customer_mobile", _fresh_phone("I")),
        "customer_address": "somewhere",
        "items": [{"name": "Item A", "qty": 1, "unit_price": 500}],
        "notes": "iter19",
    }
    body.update(overrides)
    r = requests.post(f"{API}/invoices", json=body, headers=H, timeout=30)
    assert r.status_code == 200, f"invoice create failed: {r.status_code} {r.text}"
    doc = r.json()
    _state["invoices"].append(doc["id"])
    if doc.get("sale_id"):
        _state["sales"].append(doc["sale_id"])
    return doc


# ============ TESTS ============

class TestReferenceNoDerivation:
    """POST /api/receipts auto-derives reference_no from source."""

    def test_source_invoice_uses_invoice_no(self, H):
        inv = _make_invoice(H)
        r = _make_receipt(H, source_type="invoice", source_id=inv["id"],
                          customer_mobile=inv["customer_mobile"])
        assert r["reference_no"] == inv["invoice_no"]
        assert r["source_type"] == "invoice"

    def test_source_sale_with_invoice_no(self, H):
        # Creating an invoice always creates a linked sale carrying invoice_no.
        inv = _make_invoice(H)
        sale_id = inv["sale_id"]
        assert sale_id, "invoice should have an auto-created sale"

        r = _make_receipt(H, source_type="sale", source_id=sale_id,
                          customer_mobile=inv["customer_mobile"])
        # For a sale linked to an invoice, reference_no must equal the invoice_no
        assert r["reference_no"] == inv["invoice_no"], (
            f"expected sale.invoice_no ({inv['invoice_no']}) in reference_no, "
            f"got {r['reference_no']!r}"
        )

    def test_source_sale_without_invoice_no_uses_short_id(self, H):
        # Create a standalone sale via /api/sales (no invoice)
        sbody = {
            "customer_name": "TEST19 SaleOnly",
            "customer_mobile": _fresh_phone("S"),
            "amount": 250,
            "payment_mode": "cash",
            "narration": "iter19 standalone",
        }
        sr = requests.post(f"{API}/sales", json=sbody, headers=H, timeout=30)
        assert sr.status_code == 200, f"sale create failed: {sr.status_code} {sr.text}"
        sale = sr.json()
        _state["sales"].append(sale["id"])
        assert not sale.get("invoice_no"), "sale should not have invoice_no here"

        rc = _make_receipt(H, source_type="sale", source_id=sale["id"],
                           customer_mobile=sbody["customer_mobile"])
        assert rc["reference_no"] == sale["id"][:8].upper(), (
            f"expected {sale['id'][:8].upper()}, got {rc['reference_no']}"
        )

    def test_source_collection_reference_pattern(self, H):
        # Create a collection so we have a valid source_id
        cbody = {
            "amount": 300,
            "payment_mode": "cash",
            "narration": "iter19 col",
        }
        cr = requests.post(f"{API}/collections", json=cbody, headers=H, timeout=30)
        if cr.status_code == 404:
            pytest.skip("collections endpoint not available")
        assert cr.status_code == 200, f"collection create failed: {cr.status_code} {cr.text}"
        col = cr.json()

        rc = _make_receipt(H, source_type="collection", source_id=col["id"])
        import re
        assert re.match(r"^COL-\d{8}$", rc["reference_no"]), (
            f"expected COL-YYYYMMDD, got {rc['reference_no']!r}"
        )

    def test_source_other_is_advance_empty_ref(self, H):
        r = _make_receipt(H, source_type="other")
        assert r["reference_no"] == "", f"expected empty ref for advance, got {r['reference_no']!r}"
        assert r["source_type"] == "other"

    def test_explicit_reference_no_overrides_auto(self, H):
        inv = _make_invoice(H)
        r = _make_receipt(
            H,
            source_type="invoice",
            source_id=inv["id"],
            reference_no="CUSTOM-123",
            customer_mobile=inv["customer_mobile"],
        )
        assert r["reference_no"] == "CUSTOM-123"


class TestAdvanceReceiptsList:
    """GET /api/receipts/advances."""

    def test_advances_by_phone_returns_only_advances(self, H):
        phone = _fresh_phone("A")
        adv = _make_receipt(H, customer_mobile=phone, amount=200, source_type="other")
        # Also make a non-advance receipt for same phone (has reference_no)
        _make_receipt(H, customer_mobile=phone, amount=50,
                      source_type="other", reference_no="MANUAL-1")

        r = requests.get(f"{API}/receipts/advances", params={"phone": phone},
                         headers=H, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "advances" in body and "count" in body and "total_amount" in body
        ids = [a["id"] for a in body["advances"]]
        assert adv["id"] in ids, f"advance receipt not returned: {body}"
        # Verify shape
        for a in body["advances"]:
            assert a["source_type"] == "other"
            assert (a.get("reference_no") or "") == ""
        assert body["count"] == len(body["advances"])
        assert abs(body["total_amount"] - sum(a["amount"] for a in body["advances"])) < 0.01

    def test_advances_by_customer_id(self, H):
        phone = _fresh_phone("C")
        adv = _make_receipt(H, customer_mobile=phone, amount=175, source_type="other")
        cust_id = adv.get("customer_id")
        assert cust_id, "receipt should auto-link a customer"

        r = requests.get(f"{API}/receipts/advances", params={"customer_id": cust_id},
                         headers=H, timeout=30)
        assert r.status_code == 200, r.text
        ids = [a["id"] for a in r.json()["advances"]]
        assert adv["id"] in ids

    def test_advances_missing_params_returns_400(self, H):
        r = requests.get(f"{API}/receipts/advances", headers=H, timeout=30)
        assert r.status_code == 400, f"expected 400, got {r.status_code} {r.text}"

    def test_advances_excludes_non_other_source_type(self, H):
        # Create an invoice-linked receipt (has reference_no + source_type=invoice)
        inv = _make_invoice(H)
        rc = _make_receipt(H, source_type="invoice", source_id=inv["id"],
                           customer_mobile=inv["customer_mobile"])
        r = requests.get(f"{API}/receipts/advances", params={"phone": inv["customer_mobile"]},
                         headers=H, timeout=30)
        assert r.status_code == 200, r.text
        ids = [a["id"] for a in r.json()["advances"]]
        assert rc["id"] not in ids


class TestPatchReceipt:
    """PATCH /api/receipts/{rid} — admin only."""

    def test_patch_forbidden_for_employee(self, H, HE):
        r = _make_receipt(H, source_type="other")
        rr = requests.patch(f"{API}/receipts/{r['id']}",
                            json={"reference_no": "SHOULDFAIL"},
                            headers=HE, timeout=30)
        assert rr.status_code == 403, f"expected 403 employee, got {rr.status_code} {rr.text}"

    def test_patch_admin_updates_reference_no(self, H):
        r = _make_receipt(H, source_type="other")
        rr = requests.patch(f"{API}/receipts/{r['id']}",
                            json={"reference_no": "REF-EDITED-9"},
                            headers=H, timeout=30)
        assert rr.status_code == 200, rr.text
        assert rr.json()["reference_no"] == "REF-EDITED-9"
        # Verify persistence
        g = requests.get(f"{API}/receipts/{r['id']}", headers=H, timeout=30)
        assert g.status_code == 200
        assert g.json()["reference_no"] == "REF-EDITED-9"

    def test_patch_source_change_auto_derives_reference_no(self, H):
        inv = _make_invoice(H)
        r = _make_receipt(H, source_type="other",
                          customer_mobile=inv["customer_mobile"])
        assert r["reference_no"] == ""
        rr = requests.patch(
            f"{API}/receipts/{r['id']}",
            json={"source_type": "invoice", "source_id": inv["id"]},
            headers=H, timeout=30,
        )
        assert rr.status_code == 200, rr.text
        body = rr.json()
        assert body["source_type"] == "invoice"
        assert body["source_id"] == inv["id"]
        assert body["reference_no"] == inv["invoice_no"], (
            f"expected auto-derived {inv['invoice_no']}, got {body['reference_no']!r}"
        )


class TestInvoiceAttachReceipts:
    """POST /api/invoices with attach_receipt_ids."""

    def test_attach_advance_receipt_same_customer_links(self, H):
        phone = _fresh_phone("L")
        adv = _make_receipt(H, customer_mobile=phone, amount=400, source_type="other")
        assert adv["reference_no"] == ""

        inv = _make_invoice(H, customer_mobile=phone,
                            attach_receipt_ids=[adv["id"]])
        # Reload receipt
        g = requests.get(f"{API}/receipts/{adv['id']}", headers=H, timeout=30)
        assert g.status_code == 200, g.text
        updated = g.json()
        assert updated["source_type"] == "invoice"
        assert updated["source_id"] == inv["id"]
        assert updated["reference_no"] == inv["invoice_no"]
        assert updated["source_label"] == f"Invoice {inv['invoice_no']}"

    def test_attach_receipt_different_customer_is_skipped(self, H):
        # advance receipt for customer A
        phoneA = _fresh_phone("XA")
        adv = _make_receipt(H, customer_mobile=phoneA, amount=90, source_type="other")

        # invoice for a different phone B
        phoneB = _fresh_phone("XB")
        inv = _make_invoice(H, customer_mobile=phoneB,
                            attach_receipt_ids=[adv["id"]])

        g = requests.get(f"{API}/receipts/{adv['id']}", headers=H, timeout=30)
        assert g.status_code == 200
        after = g.json()
        # Receipt must remain an advance / untouched
        assert after["source_type"] == "other", (
            f"receipt was wrongly modified across customer: {after}"
        )
        assert (after.get("reference_no") or "") == ""
        assert after["id"] != inv["id"]

    def test_attach_non_advance_receipt_is_skipped(self, H):
        # First invoice + receipt with source_type=invoice already (non-advance)
        inv1 = _make_invoice(H)
        rc = _make_receipt(H, source_type="invoice", source_id=inv1["id"],
                           customer_mobile=inv1["customer_mobile"])
        assert rc["reference_no"] == inv1["invoice_no"]

        # Now create a second invoice for same customer, try to attach rc — should skip
        inv2 = _make_invoice(H, customer_mobile=inv1["customer_mobile"],
                             attach_receipt_ids=[rc["id"]])
        g = requests.get(f"{API}/receipts/{rc['id']}", headers=H, timeout=30)
        assert g.status_code == 200
        after = g.json()
        # Should still point to inv1 (not overwritten)
        assert after["source_id"] == inv1["id"], (
            f"non-advance receipt was overwritten: {after}"
        )
        assert after["reference_no"] == inv1["invoice_no"]

    def test_attach_receipt_with_explicit_reference_no_is_skipped(self, H):
        phone = _fresh_phone("MR")
        # source_type=other BUT reference_no set → not advance
        rc = _make_receipt(H, customer_mobile=phone, source_type="other",
                           reference_no="MANUAL-REF")
        inv = _make_invoice(H, customer_mobile=phone,
                            attach_receipt_ids=[rc["id"]])
        g = requests.get(f"{API}/receipts/{rc['id']}", headers=H, timeout=30)
        assert g.status_code == 200
        after = g.json()
        assert after["reference_no"] == "MANUAL-REF"
        assert after["source_type"] == "other"
        assert after["source_id"] != inv["id"]


# ============ CLEANUP ============
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
    # Clean up auto-created TEST19 customers by phone search
    try:
        r = requests.get(f"{API}/customers", params={"scope": "all", "search": PHONE_PREFIX},
                         headers=H, timeout=30)
        if r.status_code == 200:
            for c in r.json():
                if PHONE_PREFIX in (c.get("phone") or ""):
                    requests.delete(f"{API}/customers/{c['id']}", headers=H, timeout=15)
    except Exception:
        pass
