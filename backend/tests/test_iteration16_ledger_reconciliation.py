"""
Iteration 16 backend tests.

Coverage:
- (a) GET /api/sales exposes linked_receipts per sale row (source_type='sale' & source_id=sale.id).
- (b) GET /api/customers/{cust_id}/ledger — summary math + timeline DESC + 404 on unknown.
- (c) Customer ledger picks up receipts matched by phone (customer_mobile) even without direct
      customer_id link on the receipt.
- (d) GET /api/daybook — reconciliation object (match, employees_cash_total, collector_cash_total,
      variance_total, per_denom[6], acknowledgement, acknowledged_by, acknowledged_at).
- (e) GET /api/daybook — total_collection block (daily_sales, invoices, due_collection,
      money_receipts, grand_total).
- (f) Reconciliation math: emp1 daily_sale {500:2,100:3}=1300 vs admin collection {500:2,100:2}=1200
      -> variance 100 on ₹100 (emp 3 / col 2 -> variance_pcs 1 / variance_amount 100).
- (g) POST /api/daybook/reconcile-ack requires admin; emp -> 403; admin ok, ack appears in daybook.
- (h) POST /api/collections now accepts ANY authenticated employee (emp2 posts even though he is not
      the designated collector).
- (i) GET /api/collections list still carries linked_receipts (regression guard from prior iter).

All test data prefixed TEST_it16 for cleanup.
"""
import os
import re
import datetime as dt
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    raise RuntimeError("EXPO_PUBLIC_BACKEND_URL not set for tests")

API = f"{BASE_URL}/api"
TODAY = dt.date.today().isoformat()
TAG = "TEST_it16"


# ----------------------------- helpers -----------------------------

def _login(username: str, password: str) -> str:
    r = requests.post(f"{API}/auth/login", json={"username": username, "password": password}, timeout=30)
    assert r.status_code == 200, f"login failed for {username}: {r.status_code} {r.text}"
    tok = r.json().get("access_token")
    assert tok, f"no access_token in login response for {username}"
    return tok


def _h(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


# ----------------------------- fixtures -----------------------------

@pytest.fixture(scope="module")
def tokens():
    return {
        "admin": _login("admin", "Admin@2026"),
        "emp1": _login("emp1", "Emp@2026"),
        "emp2": _login("emp2", "Emp@2026"),
    }


@pytest.fixture(scope="module")
def created():
    """Registry of created ids for teardown."""
    reg = {
        "customer_ids": [],
        "sale_ids": [],
        "receipt_ids": [],
        "collection_ids": [],
        "daily_sale_ids": [],
        "recon_date_keys": [],
    }
    yield reg
    # Teardown — best-effort admin cleanup
    try:
        admin_tok = _login("admin", "Admin@2026")
        h = _h(admin_tok)
        for rid in reg["receipt_ids"]:
            requests.delete(f"{API}/receipts/{rid}", headers=h, timeout=20)
        for sid in reg["sale_ids"]:
            requests.delete(f"{API}/sales/{sid}", headers=h, timeout=20)
        for cid in reg["collection_ids"]:
            requests.delete(f"{API}/collections/{cid}", headers=h, timeout=20)
        for did in reg["daily_sale_ids"]:
            requests.delete(f"{API}/daily-sales/{did}", headers=h, timeout=20)
        for cust_id in reg["customer_ids"]:
            requests.delete(f"{API}/customers/{cust_id}", headers=h, timeout=20)
        # reconciliation.ack records — no delete endpoint; leave in place (idempotent test key)
    except Exception as e:
        print(f"teardown warn: {e}")


# ----------------------------- (a) sales.linked_receipts -----------------------------

class TestSalesLinkedReceipts:
    def _mk_customer(self, admin_h, phone: str, name: str) -> str:
        r = requests.post(f"{API}/customers", headers=admin_h, json={
            "name": name, "phone": phone, "assigned_to": "emp1"
        }, timeout=30)
        assert r.status_code == 200, f"customer create: {r.status_code} {r.text}"
        return r.json()["id"]

    def test_sales_row_carries_linked_receipts(self, tokens, created):
        admin_h = _h(tokens["admin"])
        emp1_h = _h(tokens["emp1"])

        # unique phone per run so we don't collide with existing customers
        phone = f"9{dt.datetime.now().strftime('%H%M%S')}1616"
        cust_id = self._mk_customer(admin_h, phone, f"{TAG} SalesCust")
        created["customer_ids"].append(cust_id)

        # emp1 logs a sale for this customer
        r = requests.post(f"{API}/sales", headers=emp1_h, json={
            "customer_id": cust_id,
            "customer_name": f"{TAG} SalesCust",
            "amount": 1500,
            "product": f"{TAG} widget",
            "notes": TAG,
        }, timeout=30)
        assert r.status_code == 200, f"sale create failed: {r.status_code} {r.text}"
        sale = r.json()
        sale_id = sale["id"]
        created["sale_ids"].append(sale_id)

        # Baseline: GET /sales should include this sale with EMPTY linked_receipts initially
        r = requests.get(f"{API}/sales?scope=mine&days=7", headers=emp1_h, timeout=30)
        assert r.status_code == 200
        rows = r.json()
        this_sale = next((s for s in rows if s["id"] == sale_id), None)
        assert this_sale is not None, "created sale not returned by GET /sales"
        assert "linked_receipts" in this_sale, "sale row missing linked_receipts key"
        assert this_sale["linked_receipts"] == [], f"expected empty linked_receipts, got {this_sale['linked_receipts']}"

        # Create a receipt with source_type='sale' & source_id=sale_id
        r = requests.post(f"{API}/receipts", headers=emp1_h, json={
            "customer_name": f"{TAG} SalesCust",
            "customer_mobile": phone,
            "amount": 800,
            "payment_mode": "cash",
            "source_type": "sale",
            "source_id": sale_id,
            "narration": f"{TAG} partial",
        }, timeout=30)
        assert r.status_code == 200, f"receipt create failed: {r.status_code} {r.text}"
        rc = r.json()
        created["receipt_ids"].append(rc["id"])

        # GET /sales again — linked_receipts should now be populated
        r = requests.get(f"{API}/sales?scope=mine&days=7", headers=emp1_h, timeout=30)
        assert r.status_code == 200
        rows = r.json()
        this_sale = next((s for s in rows if s["id"] == sale_id), None)
        assert this_sale is not None
        lr = this_sale.get("linked_receipts") or []
        assert len(lr) == 1, f"expected 1 linked receipt, got {len(lr)}: {lr}"
        entry = lr[0]
        assert entry["receipt_no"] == rc["receipt_no"]
        assert float(entry["amount"]) == 800.0
        assert entry["payment_mode"] == "cash"
        assert entry.get("pdf_token"), "linked receipt should carry pdf_token"


# ----------------------------- (b) & (c) customer ledger -----------------------------

class TestCustomerLedger:
    def test_ledger_404_on_unknown(self, tokens):
        r = requests.get(f"{API}/customers/does-not-exist-9999/ledger", headers=_h(tokens["admin"]), timeout=30)
        assert r.status_code == 404, f"expected 404 for unknown customer, got {r.status_code} {r.text}"

    def test_ledger_summary_and_timeline(self, tokens, created):
        admin_h = _h(tokens["admin"])
        emp1_h = _h(tokens["emp1"])

        phone = f"9{dt.datetime.now().strftime('%H%M%S')}1617"
        # customer
        r = requests.post(f"{API}/customers", headers=admin_h, json={
            "name": f"{TAG} LedgerCust", "phone": phone, "assigned_to": "emp1"
        }, timeout=30)
        assert r.status_code == 200, r.text
        cust_id = r.json()["id"]
        created["customer_ids"].append(cust_id)

        # Sale 1: 2000
        r = requests.post(f"{API}/sales", headers=emp1_h, json={
            "customer_id": cust_id, "customer_name": f"{TAG} LedgerCust",
            "amount": 2000, "product": f"{TAG} p1", "notes": TAG,
        }, timeout=30)
        assert r.status_code == 200
        s1 = r.json(); created["sale_ids"].append(s1["id"])

        # Sale 2: 500
        r = requests.post(f"{API}/sales", headers=emp1_h, json={
            "customer_id": cust_id, "customer_name": f"{TAG} LedgerCust",
            "amount": 500, "product": f"{TAG} p2", "notes": TAG,
        }, timeout=30)
        assert r.status_code == 200
        s2 = r.json(); created["sale_ids"].append(s2["id"])

        # Receipt 1: 700 tied to sale (source_type='sale')
        r = requests.post(f"{API}/receipts", headers=emp1_h, json={
            "customer_name": f"{TAG} LedgerCust", "customer_mobile": phone,
            "amount": 700, "payment_mode": "cash",
            "source_type": "sale", "source_id": s1["id"],
            "narration": TAG,
        }, timeout=30)
        assert r.status_code == 200, r.text
        rc1 = r.json(); created["receipt_ids"].append(rc1["id"])

        # Receipt 2: 300 with source_type='other' but same phone — should be picked up by phone match
        r = requests.post(f"{API}/receipts", headers=emp1_h, json={
            "customer_name": f"{TAG} LedgerCust", "customer_mobile": phone,
            "amount": 300, "payment_mode": "online",
            "source_type": "other",
            "narration": f"{TAG} phone-match",
        }, timeout=30)
        assert r.status_code == 200, r.text
        rc2 = r.json(); created["receipt_ids"].append(rc2["id"])

        # Now fetch ledger
        r = requests.get(f"{API}/customers/{cust_id}/ledger", headers=admin_h, timeout=30)
        assert r.status_code == 200, r.text
        led = r.json()

        # Shape checks
        assert "customer" in led and led["customer"]["id"] == cust_id
        assert "summary" in led
        assert "timeline" in led
        assert "counts" in led

        summary = led["summary"]
        # sales = 2000+500 = 2500; receipts (both matched via phone) = 700+300 = 1000
        assert float(summary["total_billed"]) == 2500.0, f"total_billed: {summary}"
        assert float(summary["total_received"]) == 1000.0, f"total_received: {summary}"
        assert float(summary["due_balance"]) == 1500.0, f"due_balance: {summary}"

        # counts
        assert led["counts"]["sales"] == 2
        assert led["counts"]["receipts"] == 2

        # timeline should contain both sales + both receipts (4 events min)
        tl = led["timeline"]
        kinds = [e["kind"] for e in tl]
        assert kinds.count("sale") >= 2
        assert kinds.count("receipt") >= 2

        # DESC by when
        whens = [e.get("when") or "" for e in tl]
        assert whens == sorted(whens, reverse=True), f"timeline not sorted DESC: {whens}"

    def test_ledger_receipt_matched_by_phone_only(self, tokens, created):
        """A receipt created with no source_id but matching customer_mobile should still show up."""
        admin_h = _h(tokens["admin"])
        emp1_h = _h(tokens["emp1"])

        phone = f"9{dt.datetime.now().strftime('%H%M%S')}1618"
        r = requests.post(f"{API}/customers", headers=admin_h, json={
            "name": f"{TAG} PhoneCust", "phone": phone, "assigned_to": "emp1"
        }, timeout=30)
        assert r.status_code == 200, r.text
        cust_id = r.json()["id"]
        created["customer_ids"].append(cust_id)

        # Standalone receipt, no source_id, only phone match
        r = requests.post(f"{API}/receipts", headers=emp1_h, json={
            "customer_name": f"{TAG} PhoneCust", "customer_mobile": phone,
            "amount": 450, "payment_mode": "cash", "source_type": "other",
            "narration": f"{TAG} standalone",
        }, timeout=30)
        assert r.status_code == 200, r.text
        rc = r.json(); created["receipt_ids"].append(rc["id"])

        r = requests.get(f"{API}/customers/{cust_id}/ledger", headers=admin_h, timeout=30)
        assert r.status_code == 200
        led = r.json()
        assert led["counts"]["sales"] == 0
        assert led["counts"]["receipts"] == 1
        assert float(led["summary"]["total_received"]) == 450.0
        # Since billed=0, due goes negative — reflect that logic literally
        assert float(led["summary"]["due_balance"]) == -450.0


# ----------------------------- (d) & (e) & (f) daybook reconciliation + total_collection -----------------------------

class TestDaybookReconciliation:
    """Uses TODAY as date_key so receipts/collections/daily_sales roll into the same day."""

    def test_reconciliation_math_and_total_collection(self, tokens, created):
        admin_h = _h(tokens["admin"])
        emp1_h = _h(tokens["emp1"])

        # Snapshot pre-state so we can validate the DELTA regardless of any other
        # daily_sales / collections already recorded for TODAY.
        r0 = requests.get(f"{API}/daybook?date={TODAY}", headers=admin_h, timeout=30)
        assert r0.status_code == 200
        pre = r0.json()
        pre_row_100 = next((x for x in pre["reconciliation"]["per_denom"] if int(x["denom"]) == 100), {})
        pre_emp_100 = int(pre_row_100.get("employees_pcs", 0))
        pre_col_100 = int(pre_row_100.get("collector_pcs", 0))
        pre_emp_cash = float(pre["reconciliation"]["employees_cash_total"])
        pre_col_cash = float(pre["reconciliation"]["collector_cash_total"])

        # daily_sale for emp1: {500:2, 100:3} -> cash = 1000+300 = 1300
        r = requests.post(f"{API}/daily-sales", headers=emp1_h, json={
            "date_key": TODAY,
            "denominations": {"500": 2, "100": 3},
            "online_total": 0,
            "notes": TAG,
        }, timeout=30)
        assert r.status_code == 200, r.text
        ds = r.json(); created["daily_sale_ids"].append(ds["id"])
        assert float(ds["cash_total"]) == 1300.0

        # collection by admin: {500:2, 100:2} -> cash = 1000+200 = 1200
        r = requests.post(f"{API}/collections", headers=admin_h, json={
            "date_key": TODAY,
            "denominations": {"500": 2, "100": 2},
            "online_total": 0,
            "notes": TAG,
        }, timeout=30)
        assert r.status_code == 200, r.text
        col = r.json(); created["collection_ids"].append(col["id"])
        assert float(col["cash_total"]) == 1200.0

        # GET daybook
        r = requests.get(f"{API}/daybook?date={TODAY}", headers=admin_h, timeout=30)
        assert r.status_code == 200, r.text
        db_ = r.json()

        # -------- reconciliation shape --------
        assert "reconciliation" in db_, "daybook missing 'reconciliation'"
        rec = db_["reconciliation"]
        for k in ("match", "employees_cash_total", "collector_cash_total", "variance_total",
                  "per_denom", "acknowledgement", "acknowledged_by", "acknowledged_at"):
            assert k in rec, f"reconciliation missing key: {k}"
        assert isinstance(rec["per_denom"], list) and len(rec["per_denom"]) == 6, \
            f"per_denom should have 6 entries, got {len(rec['per_denom'])}"

        # Because there could be pre-existing daily_sales/collections for TODAY, assert the DELTA
        # from the pre-state snapshot rather than absolute values. Our contribution:
        #   emp cash +=1300, col cash +=1200 -> variance delta = +100.
        #   ₹100 row: emp_pcs +=3, col_pcs +=2 -> variance_pcs delta = +1 (amount +100).
        assert float(rec["variance_total"]) == float(rec["employees_cash_total"]) - float(rec["collector_cash_total"])
        assert float(rec["employees_cash_total"]) - pre_emp_cash == pytest.approx(1300.0)
        assert float(rec["collector_cash_total"]) - pre_col_cash == pytest.approx(1200.0)
        # Find the ₹100 row and verify DELTA
        row_100 = next((x for x in rec["per_denom"] if int(x["denom"]) == 100), None)
        assert row_100 is not None
        emp_delta = int(row_100["employees_pcs"]) - pre_emp_100
        col_delta = int(row_100["collector_pcs"]) - pre_col_100
        assert emp_delta == 3, f"₹100 emp_pcs delta expected 3, got {emp_delta} (row={row_100})"
        assert col_delta == 2, f"₹100 col_pcs delta expected 2, got {col_delta} (row={row_100})"
        assert float(row_100["variance_amount"]) == float(row_100["variance_pcs"]) * 100

        # match must be a bool; typically False in the presence of a variance (but pre-existing
        # opposing variance could theoretically cancel our +100 bias — so only assert type).
        assert isinstance(rec["match"], bool), f"reconciliation.match should be bool, got {type(rec['match'])}"

        # -------- total_collection block --------
        assert "total_collection" in db_, "daybook missing 'total_collection'"
        tc = db_["total_collection"]
        for k in ("daily_sales", "invoices", "due_collection", "money_receipts", "grand_total"):
            assert k in tc, f"total_collection missing key: {k}"
        # numeric types
        for k in tc:
            assert isinstance(tc[k], (int, float)), f"total_collection[{k}] not numeric"

        # daily_sales & due_collection totals should be at least our injected amounts
        assert float(tc["daily_sales"]) >= 1300.0
        assert float(tc["due_collection"]) >= 1200.0


# ----------------------------- (g) reconcile-ack admin-only -----------------------------

class TestReconcileAck:
    def test_employee_ack_403(self, tokens):
        r = requests.post(f"{API}/daybook/reconcile-ack", headers=_h(tokens["emp1"]), json={
            "date_key": TODAY, "acknowledgement": f"{TAG} should not stick"
        }, timeout=30)
        assert r.status_code == 403, f"emp1 must be 403 on reconcile-ack, got {r.status_code} {r.text}"

    def test_admin_ack_and_persist(self, tokens, created):
        admin_h = _h(tokens["admin"])
        note = f"{TAG} variance is acknowledged by admin at {dt.datetime.now().isoformat()}"

        r = requests.post(f"{API}/daybook/reconcile-ack", headers=admin_h, json={
            "date_key": TODAY, "acknowledgement": note
        }, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("ok") is True
        assert isinstance(body.get("acknowledged_at"), str) and body["acknowledged_at"], "acknowledged_at missing"
        created["recon_date_keys"].append(TODAY)

        # Confirm ack surfaces in daybook
        r = requests.get(f"{API}/daybook?date={TODAY}", headers=admin_h, timeout=30)
        assert r.status_code == 200
        rec = r.json()["reconciliation"]
        assert rec.get("acknowledgement") == note
        assert rec.get("acknowledged_by") == "admin"
        assert isinstance(rec.get("acknowledged_at"), str) and rec["acknowledged_at"]

    def test_admin_ack_empty_note_400(self, tokens):
        r = requests.post(f"{API}/daybook/reconcile-ack", headers=_h(tokens["admin"]), json={
            "date_key": TODAY, "acknowledgement": "   "
        }, timeout=30)
        assert r.status_code == 400, f"empty note should be 400, got {r.status_code} {r.text}"


# ----------------------------- (h) collections POST relaxed to any employee -----------------------------

class TestCollectionsAnyEmployee:
    def test_emp2_can_post_collection(self, tokens, created):
        """Regardless of who the designated collector is, emp2 should be allowed to POST."""
        emp2_h = _h(tokens["emp2"])

        # Ensure the designated collector is NOT emp2 (set it explicitly to a different user)
        admin_h = _h(tokens["admin"])
        # try setting collector to emp1 (falls back gracefully if endpoint 400s)
        try:
            requests.put(f"{API}/admin/collector", headers=admin_h,
                         json={"username": "emp1"}, timeout=20)
        except Exception:
            pass

        r = requests.post(f"{API}/collections", headers=emp2_h, json={
            "date_key": TODAY,
            "denominations": {"200": 1},
            "online_total": 0,
            "notes": f"{TAG} by-emp2",
        }, timeout=30)
        assert r.status_code == 200, f"emp2 create collection failed: {r.status_code} {r.text}"
        col = r.json()
        created["collection_ids"].append(col["id"])
        assert col["user"] == "emp2", f"collection.user should be 'emp2' (poster), got {col.get('user')}"
        assert float(col["cash_total"]) == 200.0

    def test_collections_list_carries_linked_receipts(self, tokens, created):
        """Regression: /api/collections list still populates linked_receipts per entry."""
        emp1_h = _h(tokens["emp1"])
        admin_h = _h(tokens["admin"])

        # create a fresh collection
        r = requests.post(f"{API}/collections", headers=emp1_h, json={
            "date_key": TODAY,
            "denominations": {"500": 1},
            "notes": f"{TAG} regr",
        }, timeout=30)
        assert r.status_code == 200, r.text
        col = r.json(); created["collection_ids"].append(col["id"])

        # link a receipt (source_type='collection')
        r = requests.post(f"{API}/receipts", headers=admin_h, json={
            "customer_name": f"{TAG} RegrCust", "customer_mobile": "",
            "amount": 500, "payment_mode": "cash",
            "source_type": "collection", "source_id": col["id"],
            "narration": TAG,
        }, timeout=30)
        assert r.status_code == 200, r.text
        rc = r.json(); created["receipt_ids"].append(rc["id"])

        # list collections and find ours
        r = requests.get(f"{API}/collections?from_date={TODAY}&to_date={TODAY}&limit=200",
                         headers=admin_h, timeout=30)
        assert r.status_code == 200
        rows = r.json()
        this = next((x for x in rows if x["id"] == col["id"]), None)
        assert this is not None
        lr = this.get("linked_receipts") or []
        assert any(x.get("id") == rc["id"] for x in lr), \
            f"linked_receipts on /collections did not include our receipt: {lr}"
