"""Iteration 26 — Verify customer ledger 'overdue' logic.

Rules under test:
- A sale with NO linked money receipt is overdue (source != 'invoice').
- An invoice with NO linked money receipt is overdue.
- Summary exposes overdue_total and overdue_count matching those items.
- After a receipt is created against source_type='sale' / source_id=<sale_id>,
  that sale's overdue flag becomes False and overdue_total drops.
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login",
                      json={"username": "admin", "password": "Admin@2026"},
                      timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def h(admin_token):
    return {"Authorization": f"Bearer {admin_token}",
            "Content-Type": "application/json"}


# --- seed helpers -----------------------------------------------------------
@pytest.fixture(scope="module")
def customer(h):
    name = f"TEST_Overdue_{uuid.uuid4().hex[:6]}"
    phone = f"9{uuid.uuid4().int % 10**9:09d}"
    payload = {"name": name, "phone": phone,
               "address": "TEST address, Kolkata"}
    r = requests.post(f"{API}/customers", headers=h, json=payload, timeout=15)
    assert r.status_code in (200, 201), r.text
    body = r.json()
    cid = body.get("id") or body.get("customer_id") or body.get("_id")
    assert cid, body
    return {"id": cid, "name": name, "mobile": phone}


# --- overdue behaviour ------------------------------------------------------
class TestLedgerOverdue:
    def test_sale_without_receipt_is_overdue(self, h, customer):
        r = requests.post(f"{API}/sales", headers=h,
                          json={"customer_id": customer["id"], "customer_name": customer["name"], "customer_mobile": customer["mobile"], "amount": 2500,
                                "notes": "TEST_overdue_sale"}, timeout=15)
        assert r.status_code in (200, 201), r.text
        sale_id = r.json().get("id") or r.json().get("sale_id")
        assert sale_id

        led = requests.get(f'{API}/customers/' + customer['id'] + '/ledger',
                           headers=h, timeout=15)
        assert led.status_code == 200, led.text
        data = led.json()
        assert "summary" in data and "timeline" in data
        assert data["summary"].get("overdue_count", 0) >= 1
        assert float(data["summary"].get("overdue_total", 0)) >= 2500

        sale_ev = next((e for e in data["timeline"]
                        if e.get("kind") == "sale" and e.get("id") == sale_id),
                       None)
        assert sale_ev is not None, "sale not in timeline"
        assert sale_ev.get("overdue") is True

        # save for next test
        pytest.sale_id = sale_id
        pytest.pre_overdue_total = float(data["summary"]["overdue_total"])

    def test_receipt_clears_overdue(self, h, customer):
        sale_id = getattr(pytest, "sale_id", None)
        assert sale_id, "prev test must have set sale_id"

        r = requests.post(f"{API}/receipts", headers=h,
                          json={"customer_id": customer["id"], "customer_name": customer["name"], "customer_mobile": customer["mobile"], "amount": 2500,
                                "mode": "cash",
                                "source_type": "sale",
                                "source_id": sale_id,
                                "notes": "TEST_clears_overdue"},
                          timeout=15)
        assert r.status_code in (200, 201), r.text

        led = requests.get(f'{API}/customers/' + customer['id'] + '/ledger',
                           headers=h, timeout=15)
        data = led.json()
        sale_ev = next((e for e in data["timeline"]
                        if e.get("kind") == "sale" and e.get("id") == sale_id),
                       None)
        assert sale_ev is not None
        assert sale_ev.get("overdue") is False, "receipt should clear overdue"

        assert float(data["summary"]["overdue_total"]) < pytest.pre_overdue_total

    def test_invoice_without_receipt_is_overdue(self, h, customer):
        payload = {
            "customer_id": customer["id"], "customer_name": customer["name"], "customer_mobile": customer["mobile"],
            "items": [{"name": "TEST item", "qty": 1, "rate": 4000}],
            "notes": "TEST_overdue_invoice",
        }
        r = requests.post(f"{API}/invoices", headers=h, json=payload,
                          timeout=15)
        assert r.status_code in (200, 201), r.text
        inv_id = r.json().get("id") or r.json().get("invoice_id")
        assert inv_id

        led = requests.get(f'{API}/customers/' + customer['id'] + '/ledger',
                           headers=h, timeout=15).json()
        inv_ev = next((e for e in led["timeline"]
                       if e.get("kind") == "invoice" and e.get("id") == inv_id),
                      None)
        assert inv_ev is not None
        assert inv_ev.get("overdue") is True
        assert led["summary"]["overdue_count"] >= 1
