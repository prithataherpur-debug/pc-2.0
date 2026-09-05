"""
Iteration 15 — Daybook now includes Receipts + Invoices sections,
with linked_receipts on collections / daily_sales / invoices entries.

Also verifies:
- GET /api/collections listing includes linked_receipts (duplicate-prevention badge)
- Any authenticated employee (not just admin) can POST /api/receipts with
  source_type='collection'
- grand_total math correctness (linked receipts NOT double-counted,
  only source_type='other' receipts add to totals).
"""

import os
import datetime as dt
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL must be set"
API = f"{BASE_URL}/api"

ADMIN = {"username": "admin", "password": "Admin@2026"}
EMP_PW = "Emp@2026"
TODAY = dt.date.today().isoformat()  # receipts always get today_key() server-side


# ---------- helpers ----------
def _login(username: str, password: str) -> str:
    r = requests.post(f"{API}/auth/login", json={"username": username, "password": password}, timeout=15)
    r.raise_for_status()
    return r.json()["access_token"]


def _hdr(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


# ---------- fixtures ----------
@pytest.fixture(scope="module")
def admin_token():
    return _login(**ADMIN)


@pytest.fixture(scope="module")
def emp1_token():
    return _login("emp1", EMP_PW)


@pytest.fixture(scope="module")
def created(admin_token):
    """Track ids created so we can clean up at the end."""
    bag = {"ds": [], "col": [], "rc": [], "inv": []}
    yield bag
    hdr = _hdr(admin_token)
    # receipts must be deleted before invoices (invoice delete cascades sale row)
    for rid in bag["rc"]:
        try:
            requests.delete(f"{API}/receipts/{rid}", headers=hdr, timeout=15)
        except Exception:
            pass
    for iid in bag["inv"]:
        try:
            requests.delete(f"{API}/invoices/{iid}", headers=hdr, timeout=15)
        except Exception:
            pass
    for cid in bag["col"]:
        try:
            requests.delete(f"{API}/collections/{cid}", headers=hdr, timeout=15)
        except Exception:
            pass
    for did in bag["ds"]:
        try:
            requests.delete(f"{API}/daily-sales/{did}", headers=hdr, timeout=15)
        except Exception:
            pass


# ============================================================
# Seeding: build the exact grand-total scenario from the spec
# ============================================================
class TestSeed:
    """
    Builds a day (=today) with:
      - 1 daily_sale  cash 1000 + online 500  (grand 1500)
      - 1 collection  cash 2000 + online 0    (grand 2000)
      - 1 receipt linked to that collection (source_type='collection', amount 800, cash)
      - 1 receipt source_type='other' amount 300 (cash)
    Expected grand_total:
      cash   = 1000 + 2000 + 300 = 3300
      online = 500  + 0    + 0   = 500
      total  = 3800
    """

    def test_seed_daily_sale(self, admin_token, created):
        r = requests.post(
            f"{API}/daily-sales",
            headers=_hdr(admin_token),
            json={
                "date_key": TODAY,
                "denominations": {"500": 2},   # 500 * 2 = 1000 cash
                "online_total": 500,
                "notes": "TEST_it15 daily-sale",
            },
            timeout=15,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["cash_total"] == 1000 and d["online_total"] == 500 and d["grand_total"] == 1500
        created["ds"].append(d["id"])

    def test_seed_collection(self, admin_token, created):
        r = requests.post(
            f"{API}/collections",
            headers=_hdr(admin_token),
            json={
                "date_key": TODAY,
                "denominations": {"500": 4},   # 500 * 4 = 2000 cash
                "online_total": 0,
                "notes": "TEST_it15 collection",
            },
            timeout=15,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["cash_total"] == 2000 and d["online_total"] == 0 and d["grand_total"] == 2000
        created["col"].append(d["id"])

    def test_emp_can_create_receipt_linked_to_collection(self, emp1_token, created):
        """Any authenticated employee (not just admin) can POST a receipt
        with source_type='collection' and source_id=<collection.id>."""
        assert created["col"], "seed collection must exist"
        col_id = created["col"][0]
        r = requests.post(
            f"{API}/receipts",
            headers=_hdr(emp1_token),
            json={
                "customer_name": "TEST_it15 CollectionPayer",
                "customer_mobile": "9990001111",
                "amount": 800,
                "payment_mode": "cash",
                "source_type": "collection",
                "source_id": col_id,
                "notes": "TEST_it15 linked receipt",
            },
            timeout=30,
        )
        assert r.status_code == 200, f"employee should be able to create receipt linked to collection: {r.status_code} {r.text}"
        d = r.json()
        assert d["source_type"] == "collection"
        assert d["source_id"] == col_id
        assert d["amount"] == 800
        assert d["payment_mode"] == "cash"
        # source_label should resolve for collection type
        assert d.get("source_label"), "source_label should be resolved for collection"
        assert d.get("pdf_token"), "pdf_token should be attached in response"
        created["rc"].append(d["id"])

    def test_seed_receipt_source_other(self, emp1_token, created):
        r = requests.post(
            f"{API}/receipts",
            headers=_hdr(emp1_token),
            json={
                "customer_name": "TEST_it15 AdhocPayer",
                "customer_mobile": "9990002222",
                "amount": 300,
                "payment_mode": "cash",
                "source_type": "other",
                "notes": "TEST_it15 other receipt",
            },
            timeout=30,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["source_type"] == "other"
        assert d["amount"] == 300
        created["rc"].append(d["id"])


# ============================================================
# Daybook shape + linked_receipts + math
# ============================================================
class TestDaybookShape:
    @pytest.fixture(scope="class")
    def daybook(self, admin_token):
        r = requests.get(f"{API}/daybook?date={TODAY}", headers=_hdr(admin_token), timeout=20)
        assert r.status_code == 200, r.text
        return r.json()

    def test_daybook_has_four_sections(self, daybook):
        for key in ("due_collection", "daily_sales", "receipts", "invoices", "grand_total"):
            assert key in daybook, f"missing section '{key}' in daybook response"
        assert daybook["date"] == TODAY

    def test_receipts_section_shape(self, daybook, created):
        rc = daybook["receipts"]
        for k in ("cash", "online", "total", "entries"):
            assert k in rc, f"receipts section missing '{k}'"
        # our two TEST receipts should be present
        ids = {e["id"] for e in rc["entries"]}
        for rid in created["rc"]:
            assert rid in ids, f"receipt {rid} not in daybook.receipts.entries"
        # each entry must carry display_name + pdf_token
        for e in rc["entries"]:
            if e["id"] in created["rc"]:
                assert e.get("display_name"), f"receipt {e['id']} missing display_name"
                assert e.get("pdf_token"), f"receipt {e['id']} missing pdf_token"

    def test_invoices_section_shape(self, daybook):
        inv = daybook["invoices"]
        for k in ("cash", "online", "total", "entries"):
            assert k in inv, f"invoices section missing '{k}'"
        assert isinstance(inv["entries"], list)

    def test_collection_entry_has_linked_receipts(self, daybook, created):
        assert created["col"], "need seeded collection"
        col_id = created["col"][0]
        entry = next((e for e in daybook["due_collection"]["entries"] if e["id"] == col_id), None)
        assert entry is not None, "seeded collection not in daybook.due_collection.entries"
        assert "linked_receipts" in entry, "collection entry missing linked_receipts"
        # the 800-linked receipt must appear here
        linked_ids = {lr["id"] for lr in entry["linked_receipts"]}
        assert created["rc"][0] in linked_ids, "collection-linked receipt not attached"
        # amount and payment_mode preserved
        lr = next(lr for lr in entry["linked_receipts"] if lr["id"] == created["rc"][0])
        assert lr["amount"] == 800
        assert lr["payment_mode"] == "cash"
        assert lr.get("receipt_no"), "linked_receipt should include receipt_no"

    def test_daily_sales_entry_has_linked_receipts_field(self, daybook, created):
        # every daily_sales entry must at least have the field (may be [])
        for e in daybook["daily_sales"]["entries"]:
            assert "linked_receipts" in e, f"daily_sale {e.get('id')} missing linked_receipts"

    def test_invoice_entry_has_linked_receipts_field(self, daybook):
        for iv in daybook["invoices"]["entries"]:
            assert "linked_receipts" in iv, f"invoice {iv.get('id')} missing linked_receipts"
            # display_name + pdf_token should be attached
            assert iv.get("display_name"), "invoice missing display_name"
            # pdf_token only present if pdf_path exists — invoice creation always writes PDF
            assert iv.get("pdf_token"), "invoice missing pdf_token"

    def test_grand_total_math(self, daybook, created):
        """
        Only TEST_it15 seed data is deterministic on this workspace / day.
        So we assert lower-bound math on the seeded portion using per-section totals.
        - daily_sales must include our 1500 (cash 1000, online 500)
        - due_collection must include our 2000 (cash 2000)
        - receipts section aggregates all receipts (1100 cash total for our two)
        - grand_total = daily_sales + due_collection + only 'other' receipts (300)
        Since other rows could exist on the same day, we assert that our
        contributions are reflected — i.e. subtract-check.
        """
        ds = daybook["daily_sales"]
        col = daybook["due_collection"]
        rc = daybook["receipts"]
        g = daybook["grand_total"]

        # sums are floats
        assert ds["cash"] >= 1000 and ds["online"] >= 500 and ds["total"] >= 1500
        assert col["cash"] >= 2000 and col["total"] >= 2000
        # our two receipts (800 + 300 = 1100) cash-only should be reflected
        assert rc["cash"] >= 1100
        assert rc["total"] >= 1100

        # Grand total: daily_sales + collections + ONLY 'other' receipts (300).
        # The 800 linked receipt must NOT be double-counted.
        # So grand.total - (ds.total + col.total) should ≈ sum of 'other' receipts for the day.
        # We assert: contribution from our 'other' receipt (300) is present
        # and that the linked receipt (800) is NOT added on top of collections.
        residual = g["total"] - ds["total"] - col["total"]
        # residual should include our 300 but not our 800
        assert residual >= 300 - 0.001, f"grand_total missing 'other' receipt contribution (residual={residual})"
        # If the linked 800 were double-counted, residual would jump by 800.
        # Bound: residual should be < (sum of all 'other' receipts today + small slack).
        # Compute sum of 'other' receipts from the receipts.entries list.
        other_sum = sum(
            float(e.get("amount") or 0)
            for e in rc["entries"]
            if (e.get("source_type") or "other").lower() == "other"
        )
        assert residual <= other_sum + 0.001, (
            f"linked receipts appear to be double-counted: "
            f"residual={residual}, sum_of_other_receipts={other_sum}"
        )

        # Cash / online decomposition consistent with sections
        assert abs(g["cash"] + g["online"] - g["total"]) < 0.01

    def test_grand_total_isolated_day(self, admin_token, emp1_token):
        """
        Deterministic isolated verification: pick a future date_key with no
        seeded activity, insert exactly the spec scenario, and assert exact
        grand_total values. Then clean up.

        NOTE: receipts always get today_key() server-side, so we cannot make
        receipts land on a future date. This test is therefore skipped and
        the math is validated in the residual test above.
        """
        pytest.skip("Receipts always land on today's date_key server-side; residual math checked in previous test")


# ============================================================
# GET /api/collections listing must include linked_receipts
# ============================================================
class TestCollectionsListingLinkedReceipts:
    def test_collections_list_has_linked_receipts(self, admin_token, created):
        assert created["col"], "need seeded collection"
        col_id = created["col"][0]
        r = requests.get(
            f"{API}/collections?from_date={TODAY}&to_date={TODAY}",
            headers=_hdr(admin_token),
            timeout=15,
        )
        assert r.status_code == 200, r.text
        entries = r.json()
        entry = next((e for e in entries if e["id"] == col_id), None)
        assert entry is not None, "seeded collection not in /collections listing"
        assert "linked_receipts" in entry, "collection listing missing linked_receipts field"
        assert isinstance(entry["linked_receipts"], list)
        # our 800-cash receipt should be attached
        ids = {lr["id"] for lr in entry["linked_receipts"]}
        assert created["rc"][0] in ids, "expected linked receipt missing from /collections listing"


# ============================================================
# Auth guard: employee CAN create receipt vs collection
# (this is the key business rule change of iteration 15)
# ============================================================
class TestEmployeeReceiptPermission:
    def test_employee_receipt_other_source(self, emp1_token, created):
        r = requests.post(
            f"{API}/receipts",
            headers=_hdr(emp1_token),
            json={
                "customer_name": "TEST_it15 EmpOther",
                "amount": 10,
                "payment_mode": "cash",
                "source_type": "other",
                "notes": "TEST_it15 emp other",
            },
            timeout=30,
        )
        assert r.status_code == 200, f"employee should be able to create 'other' receipt: {r.status_code} {r.text}"
        created["rc"].append(r.json()["id"])

    def test_employee_receipt_collection_source(self, emp1_token, created):
        """Even though only collector/admin can create collections,
        ANY employee must be allowed to raise a receipt against one."""
        assert created["col"], "need seeded collection"
        r = requests.post(
            f"{API}/receipts",
            headers=_hdr(emp1_token),
            json={
                "customer_name": "TEST_it15 EmpVsCollection",
                "amount": 25,
                "payment_mode": "online",
                "source_type": "collection",
                "source_id": created["col"][0],
                "notes": "TEST_it15 emp vs collection",
            },
            timeout=30,
        )
        assert r.status_code == 200, (
            f"employee (non-admin) MUST be allowed to create receipt against a collection; "
            f"got {r.status_code}: {r.text}"
        )
        d = r.json()
        assert d["user"] == "emp1"
        assert d["source_type"] == "collection"
        assert d["source_id"] == created["col"][0]
        created["rc"].append(d["id"])
