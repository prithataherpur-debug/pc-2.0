"""Iteration 27 - Verify online-collection appears in Daybook when a sale/invoice
is punched as CASH but paid with an ONLINE money receipt (linked-receipt sourced split)."""
import os
import uuid
import requests
import pytest
from pathlib import Path


def _load_backend_url():
    v = os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    if v:
        return v
    env_path = Path("/app/frontend/.env")
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
                return line.split("=", 1)[1].strip().strip('"')
    raise RuntimeError("EXPO_PUBLIC_BACKEND_URL not set")


BASE_URL = _load_backend_url().rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(f"{API}/auth/login", json={"username": "admin", "password": "Admin@2026"}, timeout=20)
    assert r.status_code == 200, r.text
    token = r.json()["access_token"]
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def customer(admin_headers):
    phone = f"9190{uuid.uuid4().hex[:7]}"
    payload = {
        "name": f"TEST_DBOnline_{uuid.uuid4().hex[:6]}",
        "phone": phone,
        "mobile": phone,
        "notes": "iteration27",
    }
    r = requests.post(f"{API}/customers", headers=admin_headers, json=payload, timeout=20)
    assert r.status_code in (200, 201), r.text
    cust = r.json()
    yield cust
    # attempt cleanup (soft delete if endpoint exists)
    cid = cust.get("id")
    if cid:
        requests.delete(f"{API}/customers/{cid}", headers=admin_headers, timeout=15)


def _daybook(admin_headers, date):
    r = requests.get(f"{API}/daybook", headers=admin_headers, params={"date": date}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


def _today_from_daybook(admin_headers):
    # ask backend for today's daybook to know the server day_key
    r = requests.get(f"{API}/daybook", headers=admin_headers, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["date"]


# --- test 1: cash-punched sale + online receipt => grand_total.online rises ---
def test_online_receipt_against_cash_sale_shows_online_in_daybook(admin_headers, customer):
    day = _today_from_daybook(admin_headers)
    before = _daybook(admin_headers, day)
    b_cash = float(before["grand_total"]["cash"])
    b_online = float(before["grand_total"]["online"])
    b_sales_online = float(before["sales"]["online"])
    b_sales_cash = float(before["sales"]["cash"])

    amt = 6000.0
    # Punch a sale as CASH
    sale_payload = {
        "customer_id": customer["id"],
        "customer_name": customer["name"],
        "amount": amt,
        "product": "TEST_ProdOnlineDaybook",
        "cash_amount": amt,
        "online_amount": 0,
    }
    r = requests.post(f"{API}/sales", headers=admin_headers, json=sale_payload, timeout=20)
    assert r.status_code in (200, 201), r.text
    sale = r.json()
    sale_id = sale["id"]

    # After the sale (no receipt yet) — must NOT be counted
    mid = _daybook(admin_headers, day)
    # sale should be present with counted=False
    sale_entry = next((s for s in mid["sales"]["entries"] if s["id"] == sale_id), None)
    assert sale_entry is not None, "sale not visible in daybook"
    assert sale_entry.get("counted") is False, "sale should NOT be counted before a receipt is linked"
    assert float(mid["grand_total"]["online"]) == pytest.approx(b_online, abs=0.01), "online should not change yet"
    assert float(mid["grand_total"]["cash"]) == pytest.approx(b_cash, abs=0.01), "cash should not change yet"

    # Post an ONLINE money receipt against the sale
    rec_payload = {
        "customer_id": customer["id"],
        "customer_name": customer["name"],
        "customer_mobile": customer.get("mobile", ""),
        "amount": amt,
        "payment_mode": "online",
        "cash_amount": 0,
        "online_amount": amt,
        "source_type": "sale",
        "source_id": sale_id,
    }
    r = requests.post(f"{API}/receipts", headers=admin_headers, json=rec_payload, timeout=20)
    assert r.status_code in (200, 201), r.text

    after = _daybook(admin_headers, day)
    a_cash = float(after["grand_total"]["cash"])
    a_online = float(after["grand_total"]["online"])
    a_sales_cash = float(after["sales"]["cash"])
    a_sales_online = float(after["sales"]["online"])

    # grand_total.online should rise by amt, cash unchanged
    assert a_online - b_online == pytest.approx(amt, abs=0.01), (
        f"grand_total.online should rise by {amt}: before={b_online} after={a_online}"
    )
    assert a_cash - b_cash == pytest.approx(0.0, abs=0.01), (
        f"grand_total.cash should be unchanged: before={b_cash} after={a_cash}"
    )
    # sales.online should also reflect the online receipt
    assert a_sales_online - b_sales_online == pytest.approx(amt, abs=0.01)
    assert a_sales_cash - b_sales_cash == pytest.approx(0.0, abs=0.01)

    # Now the sale should be counted
    sale_entry = next((s for s in after["sales"]["entries"] if s["id"] == sale_id), None)
    assert sale_entry is not None
    assert sale_entry.get("counted") is True


# --- test 2: cash receipt against sale still counts as cash ---
def test_cash_receipt_against_sale_still_counts_as_cash(admin_headers, customer):
    day = _today_from_daybook(admin_headers)
    before = _daybook(admin_headers, day)
    b_cash = float(before["grand_total"]["cash"])
    b_online = float(before["grand_total"]["online"])

    amt = 2500.0
    r = requests.post(f"{API}/sales", headers=admin_headers, json={
        "customer_id": customer["id"], "customer_name": customer["name"],
        "amount": amt, "product": "TEST_Cash", "cash_amount": amt, "online_amount": 0,
    }, timeout=20)
    assert r.status_code in (200, 201)
    sale_id = r.json()["id"]

    r = requests.post(f"{API}/receipts", headers=admin_headers, json={
        "customer_id": customer["id"], "customer_name": customer["name"],
        "customer_mobile": customer.get("mobile", ""),
        "amount": amt, "payment_mode": "cash", "cash_amount": amt, "online_amount": 0,
        "source_type": "sale", "source_id": sale_id,
    }, timeout=20)
    assert r.status_code in (200, 201)

    after = _daybook(admin_headers, day)
    assert float(after["grand_total"]["cash"]) - b_cash == pytest.approx(amt, abs=0.01)
    assert float(after["grand_total"]["online"]) - b_online == pytest.approx(0.0, abs=0.01)


# --- test 3: invoice + online receipt => grand_total.online rises ---
def test_online_receipt_against_invoice_shows_online(admin_headers, customer):
    day = _today_from_daybook(admin_headers)
    before = _daybook(admin_headers, day)
    b_online = float(before["grand_total"]["online"])
    b_cash = float(before["grand_total"]["cash"])
    b_inv_online = float(before["invoices"]["online"])

    amt = 4500.0
    # create invoice - try common payload shapes
    inv_payload = {
        "customer_id": customer["id"],
        "customer_name": customer["name"],
        "customer_mobile": customer.get("mobile", ""),
        "items": [{"name": "TEST_InvItem", "qty": 1, "unit_price": amt, "amount": amt}],
        "cash_amount": amt,
        "online_amount": 0,
    }
    r = requests.post(f"{API}/invoices", headers=admin_headers, json=inv_payload, timeout=20)
    assert r.status_code in (200, 201), r.text
    inv = r.json()
    inv_id = inv["id"]

    # Post an ONLINE money receipt against the invoice
    r = requests.post(f"{API}/receipts", headers=admin_headers, json={
        "customer_id": customer["id"], "customer_name": customer["name"],
        "customer_mobile": customer.get("mobile", ""),
        "amount": amt, "payment_mode": "online", "cash_amount": 0, "online_amount": amt,
        "source_type": "invoice", "source_id": inv_id,
    }, timeout=20)
    assert r.status_code in (200, 201), r.text

    after = _daybook(admin_headers, day)
    a_online = float(after["grand_total"]["online"])
    a_cash = float(after["grand_total"]["cash"])
    a_inv_online = float(after["invoices"]["online"])

    assert a_online - b_online == pytest.approx(amt, abs=0.01), (
        f"grand_total.online should rise by {amt}: before={b_online} after={a_online}"
    )
    assert a_cash - b_cash == pytest.approx(0.0, abs=0.01)
    assert a_inv_online - b_inv_online == pytest.approx(amt, abs=0.01)

    # invoice entry counted flag
    inv_entry = next((iv for iv in after["invoices"]["entries"] if iv["id"] == inv_id), None)
    assert inv_entry is not None
    assert inv_entry.get("counted") is True
    # verify linked_receipts include online split
    assert any(float(x.get("online_amount") or 0) == pytest.approx(amt, abs=0.01) for x in inv_entry.get("linked_receipts", []))


# --- test 4: sale/invoice without a linked receipt is NOT counted ---
def test_sale_without_receipt_is_not_counted(admin_headers, customer):
    day = _today_from_daybook(admin_headers)
    before = _daybook(admin_headers, day)
    b_grand = float(before["grand_total"]["total"])

    amt = 999.0
    r = requests.post(f"{API}/sales", headers=admin_headers, json={
        "customer_id": customer["id"], "customer_name": customer["name"],
        "amount": amt, "product": "TEST_NoReceipt", "cash_amount": amt, "online_amount": 0,
    }, timeout=20)
    assert r.status_code in (200, 201)
    sale_id = r.json()["id"]

    after = _daybook(admin_headers, day)
    a_grand = float(after["grand_total"]["total"])
    # grand total should NOT change
    assert a_grand == pytest.approx(b_grand, abs=0.01), f"grand_total should not include un-receipted sale (before={b_grand}, after={a_grand})"

    entry = next((s for s in after["sales"]["entries"] if s["id"] == sale_id), None)
    assert entry is not None
    assert entry.get("counted") is False


# --- test 5: no double counting — receipt linked to same-day sale is not standalone ---
def test_no_double_counting_linked_receipt(admin_headers, customer):
    day = _today_from_daybook(admin_headers)
    before = _daybook(admin_headers, day)
    b_standalone = float(before["standalone_receipts"]["total"])
    b_grand = float(before["grand_total"]["total"])

    amt = 1500.0
    r = requests.post(f"{API}/sales", headers=admin_headers, json={
        "customer_id": customer["id"], "customer_name": customer["name"],
        "amount": amt, "product": "TEST_NoDup", "cash_amount": 0, "online_amount": amt,
    }, timeout=20)
    assert r.status_code in (200, 201)
    sale_id = r.json()["id"]

    r = requests.post(f"{API}/receipts", headers=admin_headers, json={
        "customer_id": customer["id"], "customer_name": customer["name"],
        "customer_mobile": customer.get("mobile", ""),
        "amount": amt, "payment_mode": "online", "cash_amount": 0, "online_amount": amt,
        "source_type": "sale", "source_id": sale_id,
    }, timeout=20)
    assert r.status_code in (200, 201)

    after = _daybook(admin_headers, day)
    # standalone_receipts must NOT have grown (this receipt was linked to a same-day sale)
    assert float(after["standalone_receipts"]["total"]) == pytest.approx(b_standalone, abs=0.01)
    # grand total should have risen by exactly amt (once)
    assert float(after["grand_total"]["total"]) - b_grand == pytest.approx(amt, abs=0.01)
