"""
Iteration 21 backend tests — BUG FIX regression
=================================================
BUG: /api/daybook was hardcoding invoice cash/online to 0 and grand_total math
     needed rewriting since invoices no longer auto-create sales.

Verifications:

1) GET /api/daybook — invoices.cash and invoices.online populated from
   invoice.cash_amount / invoice.online_amount for a fresh invoice.

2) Legacy compat: an invoice inserted directly into Mongo WITHOUT
   cash_amount/online_amount is treated as all-cash by the daybook aggregation.

3) Daybook grand_total sums:
     due_collection cash + invoices cash + standalone-receipts (source_type='other') cash
   (and same for online). daily_sales section is NOT double counted.

4) daily_sales section is still returned (own totals independent of grand_total).

5) total_collection card still populated with 4 breakdown fields (daily_sales,
   invoices, due_collection, money_receipts) plus grand_total.
"""

# ---- imports -------------------------------------------------------------
import os
import sys
import uuid
import asyncio
import datetime as _dt
import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient

BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
    or ""
).rstrip("/")
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL must be set"
API = f"{BASE_URL}/api"

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

ADMIN = ("admin", "Admin@2026")
PHONE_PREFIX = "91TEST21"
TODAY = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d")


# ---- helpers -------------------------------------------------------------
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


_state = {"receipts": [], "invoices": [], "collections": [], "customers": [], "legacy_invoices": []}


def _fresh_phone(tag: str) -> str:
    n = uuid.uuid4().hex[:6]
    return f"{PHONE_PREFIX}{tag}{n}"[:15]


def _get_daybook(H, date=TODAY):
    r = requests.get(f"{API}/daybook", params={"date": date}, headers=H, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


# ---- 1) invoice cash/online populated in daybook -------------------------
class TestDaybookInvoiceSplit:
    def test_invoice_split_reflected_in_daybook(self, H):
        # Snapshot before
        before = _get_daybook(H)
        b_inv = before["invoices"]
        b_grand = before["grand_total"]

        # Create invoice: total 5000, cash=3000, online=2000
        r = requests.post(
            f"{API}/invoices",
            json={
                "customer_name": "TEST21 InvSplit",
                "customer_mobile": _fresh_phone("A"),
                "customer_address": "n/a",
                "items": [{"name": "Widget", "qty": 1, "unit_price": 5000}],
                "cash_amount": 3000,
                "online_amount": 2000,
                "notes": "iter21-daybook",
            },
            headers=H, timeout=30,
        )
        assert r.status_code == 200, r.text
        inv = r.json()
        _state["invoices"].append(inv["id"])
        assert inv["cash_amount"] == 3000.0
        assert inv["online_amount"] == 2000.0
        assert inv["total"] == 5000.0

        # Snapshot after — delta MUST be +3000 cash / +2000 online / +5000 total
        after = _get_daybook(H)
        a_inv = after["invoices"]
        a_grand = after["grand_total"]

        d_cash = a_inv["cash"] - b_inv["cash"]
        d_online = a_inv["online"] - b_inv["online"]
        d_total = a_inv["total"] - b_inv["total"]
        assert abs(d_cash - 3000.0) < 0.01, f"invoices.cash delta: {d_cash} (expected 3000)"
        assert abs(d_online - 2000.0) < 0.01, f"invoices.online delta: {d_online} (expected 2000)"
        assert abs(d_total - 5000.0) < 0.01, f"invoices.total delta: {d_total} (expected 5000)"

        # Grand total should have moved by the same amounts (invoice contributes)
        g_dc = a_grand["cash"] - b_grand["cash"]
        g_do = a_grand["online"] - b_grand["online"]
        g_dt = a_grand["total"] - b_grand["total"]
        assert abs(g_dc - 3000.0) < 0.01, f"grand.cash delta: {g_dc}"
        assert abs(g_do - 2000.0) < 0.01, f"grand.online delta: {g_do}"
        assert abs(g_dt - 5000.0) < 0.01, f"grand.total delta: {g_dt}"


# ---- 2) legacy compat: no cash_amount/online_amount fields ---------------
class TestDaybookLegacyInvoice:
    def test_legacy_invoice_treated_as_all_cash(self, H):
        before = _get_daybook(H)
        b_inv = before["invoices"]

        # Insert legacy-style invoice directly into MongoDB
        client = AsyncIOMotorClient(MONGO_URL)
        db = client[DB_NAME]
        legacy_id = str(uuid.uuid4())
        legacy_doc = {
            "id": legacy_id,
            "invoice_no": f"TEST21LEG-{uuid.uuid4().hex[:6]}",
            "user": "admin",
            "customer_id": None,
            "customer_name": "TEST21 Legacy",
            "customer_mobile": _fresh_phone("LEG"),
            "customer_address": "n/a",
            "items": [{"name": "LegacyItem", "qty": 1, "unit_price": 1500,
                       "amount": 1500}],
            "subtotal": 1500.0,
            "discount": 0.0,
            "tax": 0.0,
            "total": 1500.0,
            "notes": "iter21-legacy",
            "date_key": TODAY,
            "created_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            "updated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            "sale_id": None,
            # NOTE: intentionally NO cash_amount / online_amount / payment_mode
        }

        async def _insert():
            await db.invoices.insert_one(legacy_doc)
        asyncio.get_event_loop().run_until_complete(_insert()) if not asyncio.get_event_loop().is_running() else None
        # Simpler: use asyncio.run in a fresh loop
        try:
            asyncio.run(_insert())
        except RuntimeError:
            # If loop already running / previous asyncio.run created one — try new
            pass

        _state["legacy_invoices"].append(legacy_id)

        after = _get_daybook(H)
        a_inv = after["invoices"]

        d_cash = a_inv["cash"] - b_inv["cash"]
        d_online = a_inv["online"] - b_inv["online"]
        d_total = a_inv["total"] - b_inv["total"]
        # Legacy invoice = all cash
        assert abs(d_cash - 1500.0) < 0.01, f"legacy invoice cash delta: {d_cash} (expected 1500)"
        assert abs(d_online - 0.0) < 0.01, f"legacy invoice online delta: {d_online} (expected 0)"
        assert abs(d_total - 1500.0) < 0.01, f"legacy invoice total delta: {d_total} (expected 1500)"


# ---- 3) grand_total math across invoice + collection + standalone receipt --
class TestDaybookGrandTotalMath:
    def test_grand_total_sums_correctly(self, H):
        before = _get_daybook(H)
        b_grand = before["grand_total"]
        b_ds = before["daily_sales"]

        # 1 invoice: cash=3000 online=2000
        r = requests.post(
            f"{API}/invoices",
            json={
                "customer_name": "TEST21 GT-Inv",
                "customer_mobile": _fresh_phone("GTI"),
                "customer_address": "n/a",
                "items": [{"name": "Item", "qty": 1, "unit_price": 5000}],
                "cash_amount": 3000,
                "online_amount": 2000,
                "notes": "iter21-gt",
            },
            headers=H, timeout=30,
        )
        assert r.status_code == 200, r.text
        _state["invoices"].append(r.json()["id"])

        # 1 collection: cash=1000 online=500
        cr = requests.post(
            f"{API}/collections",
            json={"cash_total": 1000, "online_total": 500, "notes": "iter21-gt-col"},
            headers=H, timeout=30,
        )
        assert cr.status_code == 200, cr.text
        _state["collections"].append(cr.json()["id"])

        # 1 standalone receipt: source_type='other', mixed, cash=200 online=100
        rc = requests.post(
            f"{API}/receipts",
            json={
                "customer_name": "TEST21 GT-Rc",
                "customer_mobile": _fresh_phone("GTR"),
                "amount": 300.0,
                "payment_mode": "mixed",
                "cash_amount": 200.0,
                "online_amount": 100.0,
                "source_type": "other",
                "narration": "iter21-gt-rc",
            },
            headers=H, timeout=30,
        )
        assert rc.status_code == 200, rc.text
        _state["receipts"].append(rc.json()["id"])

        after = _get_daybook(H)
        a_grand = after["grand_total"]
        a_ds = after["daily_sales"]

        # Expected deltas
        exp_cash = 3000 + 1000 + 200  # 4200
        exp_online = 2000 + 500 + 100  # 2600
        exp_total = exp_cash + exp_online  # 6800

        g_dc = a_grand["cash"] - b_grand["cash"]
        g_do = a_grand["online"] - b_grand["online"]
        g_dt = a_grand["total"] - b_grand["total"]
        assert abs(g_dc - exp_cash) < 0.01, f"grand.cash delta {g_dc} != {exp_cash}"
        assert abs(g_do - exp_online) < 0.01, f"grand.online delta {g_do} != {exp_online}"
        assert abs(g_dt - exp_total) < 0.01, f"grand.total delta {g_dt} != {exp_total}"

        # daily_sales section should NOT have been touched by grand-total moves
        # (i.e., grand_total does not double-count daily_sales)
        # daily_sales.total delta should be 0 (we did not add any daily_sales doc)
        assert abs((a_ds["total"] - b_ds["total"]) - 0.0) < 0.01, (
            f"daily_sales.total drifted: {a_ds['total']} vs {b_ds['total']}"
        )


# ---- 4) daily_sales section still present + independent -------------------
class TestDaybookSectionsShape:
    def test_response_has_required_sections(self, H):
        db_json = _get_daybook(H)
        for key in ("due_collection", "daily_sales", "receipts", "invoices",
                    "grand_total", "reconciliation", "total_collection"):
            assert key in db_json, f"missing daybook key: {key}"
        for section in ("due_collection", "daily_sales", "receipts", "invoices"):
            for f in ("cash", "online", "total", "entries"):
                assert f in db_json[section], f"{section} missing field {f}"

    def test_total_collection_breakdown_populated(self, H):
        db_json = _get_daybook(H)
        tc = db_json["total_collection"]
        for f in ("daily_sales", "invoices", "due_collection",
                  "money_receipts", "grand_total"):
            assert f in tc, f"total_collection missing {f}"
            assert isinstance(tc[f], (int, float)), f"{f} not numeric: {tc[f]!r}"
        # invoices in the breakdown should match invoices.total
        assert abs(tc["invoices"] - db_json["invoices"]["total"]) < 0.01
        assert abs(tc["due_collection"] - db_json["due_collection"]["total"]) < 0.01
        assert abs(tc["daily_sales"] - db_json["daily_sales"]["total"]) < 0.01
        assert abs(tc["money_receipts"] - db_json["receipts"]["total"]) < 0.01
        assert abs(tc["grand_total"] - db_json["grand_total"]["total"]) < 0.01


# ---- CLEANUP ------------------------------------------------------------
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
    for cid in _state["collections"]:
        try:
            requests.delete(f"{API}/collections/{cid}", headers=H, timeout=15)
        except Exception:
            pass

    # Legacy invoices inserted directly into Mongo: try API delete first, else Mongo
    if _state["legacy_invoices"]:
        for lid in _state["legacy_invoices"]:
            try:
                requests.delete(f"{API}/invoices/{lid}", headers=H, timeout=15)
            except Exception:
                pass
        # Also purge from Mongo directly to be safe
        try:
            client = AsyncIOMotorClient(MONGO_URL)
            db = client[DB_NAME]

            async def _purge():
                await db.invoices.delete_many({"id": {"$in": _state["legacy_invoices"]}})
            asyncio.run(_purge())
        except Exception:
            pass

    # Clean TEST21 customers
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
