"""
Iteration 22 backend tests — bug fix regression

Two bugs verified here:

BUG 1: "Online cash via any entry should be shown in daybook"
       → GET /api/daybook must expose cash + online + total for every section
         (daily_sales, invoices, due_collection, receipts).
       → Fresh entries with online components must be reflected in the correct
         section.online counter AND in grand_total.online.
       → Legacy receipts (payment_mode='online', no cash_amount/online_amount)
         must still contribute to receipts.online via daybook's fallback logic.

BUG 2: "Daybook cash-in-hand entry can be modified by admin"
       → PATCH /api/daily-sales/{id} must allow admin to edit ANY user's entry
         (not just their own).
       → Non-admin editing someone else's entry → 403.
       → Owner editing their own entry → 200.
       → DELETE /api/daily-sales/{id} by admin → 200, then GET returns 404.

pytest-xdist note: any two tests that both mutate TODAY-shared aggregates on
`receipts.online` are grouped INSIDE ONE CLASS so loadscope pins them to a
single worker — otherwise the shared counter races across workers.
"""

import os
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
EMP1 = ("emp1", "Emp@2026")
EMP2 = ("emp2", "Emp@2026")

PHONE_PREFIX = "91TEST22"
TODAY = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d")

_state = {
    "collections": [],
    "invoices": [],
    "receipts": [],
    "legacy_receipts": [],
    "daily_sales": [],
}


# ---- helpers -------------------------------------------------------------
def _login(user, pw):
    r = requests.post(
        f"{API}/auth/login",
        json={"username": user, "password": pw},
        timeout=30,
    )
    assert r.status_code == 200, f"login {user} failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


def _H(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


def _fresh_phone(tag: str) -> str:
    return f"{PHONE_PREFIX}{tag}{uuid.uuid4().hex[:6]}"[:15]


def _get_daybook(H, date=TODAY):
    r = requests.get(f"{API}/daybook", params={"date": date}, headers=H, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


# ---- fixtures ------------------------------------------------------------
@pytest.fixture(scope="module")
def admin_token():
    return _login(*ADMIN)


@pytest.fixture(scope="module")
def emp1_token():
    return _login(*EMP1)


@pytest.fixture(scope="module")
def emp2_token():
    return _login(*EMP2)


@pytest.fixture(scope="module")
def AH(admin_token):
    return _H(admin_token)


@pytest.fixture(scope="module")
def E1H(emp1_token):
    return _H(emp1_token)


@pytest.fixture(scope="module")
def E2H(emp2_token):
    return _H(emp2_token)


# =========================================================================
# BUG 1: Online visibility across every daybook section
# =========================================================================
class TestDaybookShapeAllSectionsExposeOnline:
    """Verify daybook response shape has cash+online+total for every section."""

    def test_response_shape_has_cash_online_total(self, AH):
        db_json = _get_daybook(AH)
        for section in ("due_collection", "daily_sales", "receipts", "invoices"):
            assert section in db_json, f"missing daybook section: {section}"
            sec = db_json[section]
            for f in ("cash", "online", "total"):
                assert f in sec, f"{section} missing field {f}"
                assert isinstance(sec[f], (int, float)), (
                    f"{section}.{f} not numeric: {sec[f]!r}"
                )
                assert sec[f] >= 0, f"{section}.{f} negative: {sec[f]}"
        for f in ("cash", "online", "total"):
            assert f in db_json["grand_total"]


class TestDaybookOnlineVisibility:
    """Fresh entries + legacy receipt fallback — grouped in ONE class so
    xdist loadscope keeps them on a single worker (shared TODAY counters)."""

    def test_online_reflected_across_sections(self, AH):
        before = _get_daybook(AH)
        b_col = before["due_collection"]
        b_inv = before["invoices"]
        b_rc = before["receipts"]
        b_gr = before["grand_total"]

        # (a) 1 collection: cash=1000 online=500
        r = requests.post(
            f"{API}/collections",
            json={"cash_total": 1000, "online_total": 500, "notes": "iter22-col"},
            headers=AH, timeout=30,
        )
        assert r.status_code == 200, r.text
        _state["collections"].append(r.json()["id"])

        # (b) 1 invoice: total=5000, cash=3000, online=2000
        r = requests.post(
            f"{API}/invoices",
            json={
                "customer_name": "TEST22 InvOnline",
                "customer_mobile": _fresh_phone("INV"),
                "customer_address": "n/a",
                "items": [{"name": "Widget", "qty": 1, "unit_price": 5000}],
                "cash_amount": 3000,
                "online_amount": 2000,
                "notes": "iter22-inv",
            },
            headers=AH, timeout=30,
        )
        assert r.status_code == 200, r.text
        _state["invoices"].append(r.json()["id"])

        # (c) 1 standalone receipt (source_type='other'), mixed cash=200 online=100
        r = requests.post(
            f"{API}/receipts",
            json={
                "customer_name": "TEST22 RcOnline",
                "customer_mobile": _fresh_phone("RC"),
                "amount": 300.0,
                "payment_mode": "mixed",
                "cash_amount": 200.0,
                "online_amount": 100.0,
                "source_type": "other",
                "narration": "iter22-rc-online",
            },
            headers=AH, timeout=30,
        )
        assert r.status_code == 200, r.text
        _state["receipts"].append(r.json()["id"])

        after = _get_daybook(AH)

        d_inv_online = after["invoices"]["online"] - b_inv["online"]
        assert abs(d_inv_online - 2000.0) < 0.01, f"invoices.online delta {d_inv_online}"

        d_col_online = after["due_collection"]["online"] - b_col["online"]
        assert abs(d_col_online - 500.0) < 0.01, f"due_collection.online delta {d_col_online}"

        d_rc_online = after["receipts"]["online"] - b_rc["online"]
        assert abs(d_rc_online - 100.0) < 0.01, f"receipts.online delta {d_rc_online}"

        d_gr_online = after["grand_total"]["online"] - b_gr["online"]
        assert abs(d_gr_online - 2600.0) < 0.01, (
            f"grand_total.online delta {d_gr_online} (expected 2600)"
        )

    def test_legacy_online_receipt_via_fallback(self, AH):
        before = _get_daybook(AH)
        b_rc_online = before["receipts"]["online"]

        # Insert legacy-style receipt directly into MongoDB (no cash/online fields)
        legacy_id = str(uuid.uuid4())
        legacy_doc = {
            "id": legacy_id,
            "receipt_no": f"TEST22LEG-{uuid.uuid4().hex[:6]}",
            "user": "admin",
            "customer_id": None,
            "customer_name": "TEST22 LegacyOnline",
            "customer_mobile": _fresh_phone("LEG"),
            "customer_address": "n/a",
            "amount": 1500.0,
            "payment_mode": "online",   # legacy — mode drives fallback split
            "source_type": "other",
            "source_id": None,
            "source_label": "Other",
            "reference_no": "",
            "narration": "iter22-legacy-online",
            "date_key": TODAY,
            "created_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            "updated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            # Intentionally NO cash_amount / online_amount
        }

        async def _insert():
            client = AsyncIOMotorClient(MONGO_URL)
            db = client[DB_NAME]
            await db.receipts.insert_one(legacy_doc)
            client.close()

        asyncio.run(_insert())
        _state["legacy_receipts"].append(legacy_id)

        after = _get_daybook(AH)
        d = after["receipts"]["online"] - b_rc_online
        assert abs(d - 1500.0) < 0.01, (
            f"legacy online receipt not aggregated: delta={d} (expected 1500)"
        )


# =========================================================================
# BUG 2: Admin can PATCH/DELETE any user's daily_sales entry
# =========================================================================
class TestDailySalesAdminEditRights:
    """All PATCH/DELETE authorisation flows grouped in one class to run serially."""

    def test_admin_can_edit_emp1_entry(self, E1H, AH):
        # emp1 creates: {500:2, 100:5} → cash_total = 500*2 + 100*5 = 1500
        r = requests.post(
            f"{API}/daily-sales",
            json={"denominations": {"500": 2, "100": 5}, "online_total": 0,
                  "notes": "iter22-emp1"},
            headers=E1H, timeout=30,
        )
        assert r.status_code == 200, r.text
        sd = r.json()
        sid = sd["id"]
        _state["daily_sales"].append(sid)
        assert sd["user"] == "emp1"
        assert abs(sd["cash_total"] - 1500.0) < 0.01

        # admin PATCHes emp1's entry: {500:3, 100:5} → 500*3 + 100*5 = 2000
        r = requests.patch(
            f"{API}/daily-sales/{sid}",
            json={"denominations": {"500": 3, "100": 5}},
            headers=AH, timeout=30,
        )
        assert r.status_code == 200, (
            f"admin PATCH should succeed on emp1's entry: {r.status_code} {r.text}"
        )
        updated = r.json()
        assert updated["user"] == "emp1", "user must still be emp1"
        assert abs(updated["cash_total"] - 2000.0) < 0.01, (
            f"cash_total after admin edit expected 2000, got {updated['cash_total']}"
        )
        # Persistence check via GET list
        gr = requests.get(
            f"{API}/daily-sales",
            params={"from_date": TODAY, "to_date": TODAY, "user": "emp1"},
            headers=AH, timeout=30,
        )
        assert gr.status_code == 200, gr.text
        row = next((x for x in gr.json() if x["id"] == sid), None)
        assert row is not None, "entry disappeared after admin edit"
        assert abs(row["cash_total"] - 2000.0) < 0.01

    def test_emp2_cannot_edit_emp1_entry(self, E1H, E2H):
        # emp1 creates a fresh entry
        r = requests.post(
            f"{API}/daily-sales",
            json={"denominations": {"500": 1, "100": 2}, "online_total": 0,
                  "notes": "iter22-emp1-b"},
            headers=E1H, timeout=30,
        )
        assert r.status_code == 200, r.text
        sid = r.json()["id"]
        _state["daily_sales"].append(sid)

        # emp2 → expect 403
        r = requests.patch(
            f"{API}/daily-sales/{sid}",
            json={"denominations": {"500": 5}},
            headers=E2H, timeout=30,
        )
        assert r.status_code == 403, (
            f"emp2 editing emp1's entry should be 403, got {r.status_code} {r.text}"
        )

    def test_emp1_can_edit_own(self, E1H):
        r = requests.post(
            f"{API}/daily-sales",
            json={"denominations": {"100": 3}, "online_total": 0,
                  "notes": "iter22-emp1-own"},
            headers=E1H, timeout=30,
        )
        assert r.status_code == 200, r.text
        sid = r.json()["id"]
        _state["daily_sales"].append(sid)

        r = requests.patch(
            f"{API}/daily-sales/{sid}",
            json={"denominations": {"100": 7}, "notes": "iter22-emp1-own-edit"},
            headers=E1H, timeout=30,
        )
        assert r.status_code == 200, (
            f"owner PATCH on own entry should succeed: {r.status_code} {r.text}"
        )
        assert abs(r.json()["cash_total"] - 700.0) < 0.01

    def test_admin_can_delete_emp1_entry(self, E1H, AH):
        r = requests.post(
            f"{API}/daily-sales",
            json={"denominations": {"500": 1}, "online_total": 0,
                  "notes": "iter22-emp1-del"},
            headers=E1H, timeout=30,
        )
        assert r.status_code == 200, r.text
        sid = r.json()["id"]

        r = requests.delete(f"{API}/daily-sales/{sid}", headers=AH, timeout=30)
        assert r.status_code == 200, (
            f"admin DELETE on emp1's entry should be 200, got {r.status_code} {r.text}"
        )

        r = requests.delete(f"{API}/daily-sales/{sid}", headers=AH, timeout=30)
        assert r.status_code == 404, (
            f"after delete, further DELETE should be 404, got {r.status_code}"
        )

        gr = requests.get(
            f"{API}/daily-sales",
            params={"from_date": TODAY, "to_date": TODAY, "user": "emp1"},
            headers=AH, timeout=30,
        )
        assert gr.status_code == 200
        assert all(x["id"] != sid for x in gr.json()), "entry still visible after delete"


# =========================================================================
# CLEANUP
# =========================================================================
@pytest.fixture(scope="module", autouse=True)
def _cleanup(admin_token):
    yield
    H = _H(admin_token)

    for sid in _state["daily_sales"]:
        try:
            requests.delete(f"{API}/daily-sales/{sid}", headers=H, timeout=15)
        except Exception:
            pass
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

    # Legacy receipts inserted directly into Mongo: purge via Mongo
    if _state["legacy_receipts"]:
        async def _purge():
            client = AsyncIOMotorClient(MONGO_URL)
            db = client[DB_NAME]
            await db.receipts.delete_many({"id": {"$in": _state["legacy_receipts"]}})
            client.close()
        try:
            asyncio.run(_purge())
        except Exception:
            pass

    # Clean TEST22-tagged customers (created via auto-link)
    try:
        r = requests.get(
            f"{API}/customers",
            params={"scope": "all", "search": PHONE_PREFIX},
            headers=H, timeout=30,
        )
        if r.status_code == 200:
            for c in r.json():
                if PHONE_PREFIX in (c.get("phone") or ""):
                    try:
                        requests.delete(f"{API}/customers/{c['id']}",
                                        headers=H, timeout=15)
                    except Exception:
                        pass
    except Exception:
        pass
