"""
Iteration 12 — Admin sale edit/delete + workspace-wide collections visibility.

Backend features verified:
  1. GET /api/collections — any authenticated user sees ALL workspace entries.
  2. GET /api/collections/summary — same relaxation (workspace-wide totals for everyone).
  3. Regression: POST /api/collections still collector-or-admin only.
  4. Regression: PATCH /api/collections still owner-or-admin.
  5. Regression: DELETE /api/collections still admin-only.
  6. PATCH /api/sales/{sid} — admin can edit amount/product/notes/purchase_amount
     together and profit is recomputed. Owner cannot pass purchase_amount (403).
"""
import os
import uuid
import pytest
import requests

BASE = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
if not BASE:
    BASE = "https://mass-dialer-2.preview.emergentagent.com"
API = f"{BASE}/api"

ADMIN = ("admin", "Admin@2026")
EMP_PW = "Emp@2026"
MARKER = f"TEST_it12_{uuid.uuid4().hex[:6]}"


def _login(u, p):
    r = requests.post(f"{API}/auth/login", json={"username": u, "password": p}, timeout=15)
    assert r.status_code == 200, f"login {u}: {r.status_code} {r.text}"
    return r.json()["access_token"]


def _h(t):
    return {"Authorization": f"Bearer {t}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def admin_token():
    return _login(*ADMIN)


@pytest.fixture(scope="module")
def emp_tokens():
    # emp2 will be the collector; emp3 is a non-collector employee.
    return {u: _login(u, EMP_PW) for u in ["emp1", "emp2", "emp3"]}


@pytest.fixture(scope="module", autouse=True)
def cleanup(admin_token):
    # Reset collector, run tests, then clean everything we created.
    requests.put(f"{API}/admin/collector", json={"username": None}, headers=_h(admin_token))
    yield
    # Delete test collections
    r = requests.get(f"{API}/collections?limit=500", headers=_h(admin_token))
    if r.status_code == 200:
        for e in r.json():
            if MARKER in (e.get("notes") or ""):
                requests.delete(f"{API}/collections/{e['id']}", headers=_h(admin_token))
    # Delete test sales
    r = requests.get(f"{API}/sales?scope=all&days=2", headers=_h(admin_token))
    if r.status_code == 200:
        for s in r.json():
            if MARKER in (s.get("notes") or "") or MARKER in (s.get("product") or ""):
                requests.delete(f"{API}/sales/{s['id']}", headers=_h(admin_token))
    requests.put(f"{API}/admin/collector", json={"username": None}, headers=_h(admin_token))


# ============================================================================
# Feature 1 + 3: workspace-wide GET /collections + POST restricted
# ============================================================================
class TestCollectionsWorkspaceVisibility:
    @pytest.fixture(scope="class")
    def collector_entry(self, admin_token, emp_tokens):
        # Assign emp2 as collector, then have emp2 create an entry.
        r = requests.put(f"{API}/admin/collector", json={"username": "emp2"}, headers=_h(admin_token))
        assert r.status_code == 200, r.text
        payload = {
            "date_key": "2026-01-15",
            "denominations": {"500": 2, "100": 5},
            "online_total": 250,
            "notes": f"{MARKER} emp2 entry",
        }
        r = requests.post(f"{API}/collections", json=payload, headers=_h(emp_tokens["emp2"]))
        assert r.status_code == 200, r.text
        entry = r.json()
        assert entry["user"] == "emp2"
        assert entry["cash_total"] == 2 * 500 + 5 * 100
        assert entry["online_total"] == 250
        assert entry["grand_total"] == entry["cash_total"] + 250
        return entry

    def test_non_collector_employee_sees_workspace_entries(self, collector_entry, emp_tokens):
        """emp3 is a normal employee — must see emp2's collection entry now."""
        r = requests.get(f"{API}/collections?limit=200", headers=_h(emp_tokens["emp3"]))
        assert r.status_code == 200, r.text
        ids = [e["id"] for e in r.json()]
        assert collector_entry["id"] in ids, "emp3 should see emp2 entry (workspace-wide)"
        # And the returned row still carries its author
        row = next(e for e in r.json() if e["id"] == collector_entry["id"])
        assert row["user"] == "emp2"
        assert row["display_name"], "display_name should be attached"

    def test_admin_sees_workspace_entries(self, collector_entry, admin_token):
        r = requests.get(f"{API}/collections?limit=200", headers=_h(admin_token))
        assert r.status_code == 200
        assert any(e["id"] == collector_entry["id"] for e in r.json())

    def test_post_still_requires_collector_or_admin(self, emp_tokens):
        """emp3 (non-collector) must NOT be able to create."""
        payload = {"date_key": "2026-01-15", "denominations": {"100": 1}, "notes": f"{MARKER} nope"}
        r = requests.post(f"{API}/collections", json=payload, headers=_h(emp_tokens["emp3"]))
        assert r.status_code == 403, f"expected 403, got {r.status_code} {r.text}"

    def test_post_by_non_collector_emp1_forbidden(self, emp_tokens):
        payload = {"date_key": "2026-01-15", "denominations": {"100": 1}, "notes": f"{MARKER} nope1"}
        r = requests.post(f"{API}/collections", json=payload, headers=_h(emp_tokens["emp1"]))
        assert r.status_code == 403


# ============================================================================
# Feature 2: workspace-wide GET /collections/summary
# ============================================================================
class TestCollectionsSummaryWorkspace:
    def test_summary_shape_admin(self, admin_token):
        r = requests.get(f"{API}/collections/summary?days=7", headers=_h(admin_token))
        assert r.status_code == 200, r.text
        j = r.json()
        assert "days" in j and "totals" in j
        assert isinstance(j["days"], list) and len(j["days"]) == 7
        for k in ("cash", "online", "total"):
            assert k in j["totals"]

    def test_non_collector_sees_same_totals_as_admin(self, admin_token, emp_tokens):
        """emp3 (non-collector) must now see workspace-wide totals — matching admin's."""
        ra = requests.get(f"{API}/collections/summary?days=30", headers=_h(admin_token))
        re3 = requests.get(f"{API}/collections/summary?days=30", headers=_h(emp_tokens["emp3"]))
        assert ra.status_code == 200 and re3.status_code == 200
        assert ra.json()["totals"] == re3.json()["totals"], (
            f"emp3 totals should equal admin totals now: admin={ra.json()['totals']} emp3={re3.json()['totals']}"
        )

    def test_summary_totals_nonzero_after_seed(self, admin_token, emp_tokens):
        # After the emp2 seed entry, workspace total must be > 0 for emp3 too.
        r = requests.get(f"{API}/collections/summary?days=30", headers=_h(emp_tokens["emp3"]))
        assert r.status_code == 200
        assert r.json()["totals"]["total"] > 0


# ============================================================================
# Feature 4 + 5: PATCH owner-or-admin, DELETE admin-only regression
# ============================================================================
class TestCollectionsUpdateDelete:
    @pytest.fixture(scope="class")
    def emp2_entry(self, admin_token, emp_tokens):
        # Make sure emp2 is collector and can create.
        requests.put(f"{API}/admin/collector", json={"username": "emp2"}, headers=_h(admin_token))
        payload = {
            "date_key": "2026-01-14",
            "denominations": {"200": 3},
            "notes": f"{MARKER} to-update",
        }
        r = requests.post(f"{API}/collections", json=payload, headers=_h(emp_tokens["emp2"]))
        assert r.status_code == 200
        return r.json()

    def test_owner_can_patch(self, emp2_entry, emp_tokens):
        r = requests.patch(
            f"{API}/collections/{emp2_entry['id']}",
            json={"notes": f"{MARKER} owner-edit"},
            headers=_h(emp_tokens["emp2"]),
        )
        assert r.status_code == 200, r.text
        assert "owner-edit" in r.json()["notes"]

    def test_non_owner_non_admin_cannot_patch(self, emp2_entry, emp_tokens):
        r = requests.patch(
            f"{API}/collections/{emp2_entry['id']}",
            json={"notes": f"{MARKER} intruder"},
            headers=_h(emp_tokens["emp3"]),
        )
        assert r.status_code == 403

    def test_non_admin_cannot_delete(self, emp2_entry, emp_tokens):
        # even the OWNER (emp2) cannot delete — admin-only
        r = requests.delete(f"{API}/collections/{emp2_entry['id']}", headers=_h(emp_tokens["emp2"]))
        assert r.status_code == 403, f"owner should NOT delete: {r.status_code} {r.text}"

    def test_admin_can_delete(self, emp2_entry, admin_token):
        r = requests.delete(f"{API}/collections/{emp2_entry['id']}", headers=_h(admin_token))
        assert r.status_code == 200
        # verify gone
        g = requests.get(f"{API}/collections?limit=500", headers=_h(admin_token))
        assert emp2_entry["id"] not in [e["id"] for e in g.json()]


# ============================================================================
# Feature 6: PATCH /sales/{sid} multi-field admin edit + owner cannot set cost
# ============================================================================
class TestSalePatch:
    @pytest.fixture(scope="class")
    def emp2_sale(self, emp_tokens):
        # emp2 punches a sale for themselves
        payload = {
            "amount": 1000,
            "product": f"{MARKER}-widget",
            "notes": f"{MARKER} initial",
        }
        r = requests.post(f"{API}/sales", json=payload, headers=_h(emp_tokens["emp2"]))
        assert r.status_code == 200, r.text
        s = r.json()
        assert s["user"] == "emp2"
        assert s["amount"] == 1000
        assert s.get("purchase_amount") in (None, 0) or s["purchase_amount"] is None
        return s

    def test_owner_can_edit_own_fields(self, emp2_sale, emp_tokens):
        r = requests.patch(
            f"{API}/sales/{emp2_sale['id']}",
            json={"amount": 1200, "product": f"{MARKER}-widgetv2", "notes": f"{MARKER} owner-note"},
            headers=_h(emp_tokens["emp2"]),
        )
        assert r.status_code == 200, r.text
        s = r.json()
        assert s["amount"] == 1200
        assert s["product"] == f"{MARKER}-widgetv2"
        assert "owner-note" in s["notes"]

    def test_owner_cannot_set_purchase_amount(self, emp2_sale, emp_tokens):
        r = requests.patch(
            f"{API}/sales/{emp2_sale['id']}",
            json={"purchase_amount": 500},
            headers=_h(emp_tokens["emp2"]),
        )
        assert r.status_code == 403, f"owner must NOT set purchase_amount: {r.status_code} {r.text}"

    def test_non_owner_non_admin_cannot_patch(self, emp2_sale, emp_tokens):
        r = requests.patch(
            f"{API}/sales/{emp2_sale['id']}",
            json={"amount": 999},
            headers=_h(emp_tokens["emp3"]),
        )
        assert r.status_code == 403

    def test_admin_can_edit_all_fields_including_purchase(self, emp2_sale, admin_token):
        payload = {
            "amount": 1500,
            "product": f"{MARKER}-widgetADMIN",
            "notes": f"{MARKER} admin-note",
            "purchase_amount": 900,
        }
        r = requests.patch(f"{API}/sales/{emp2_sale['id']}", json=payload, headers=_h(admin_token))
        assert r.status_code == 200, r.text
        s = r.json()
        assert s["amount"] == 1500
        assert s["product"] == f"{MARKER}-widgetADMIN"
        assert s["purchase_amount"] == 900
        # Profit must be recomputed = amount - purchase_amount
        assert s.get("profit") == 1500 - 900, f"expected profit 600, got {s.get('profit')}"

    def test_admin_can_delete_any_sale(self, admin_token, emp_tokens):
        # emp1 creates a sale, admin deletes it
        r = requests.post(
            f"{API}/sales",
            json={"amount": 250, "product": f"{MARKER}-todel", "notes": f"{MARKER}"},
            headers=_h(emp_tokens["emp1"]),
        )
        assert r.status_code == 200
        sid = r.json()["id"]
        d = requests.delete(f"{API}/sales/{sid}", headers=_h(admin_token))
        assert d.status_code == 200
        # verify 404 on subsequent patch/delete
        g = requests.delete(f"{API}/sales/{sid}", headers=_h(admin_token))
        assert g.status_code == 404

    def test_non_admin_cannot_delete_sale(self, emp_tokens):
        # emp1 creates a sale, emp1 (owner) tries to delete → forbidden (admin-only)
        r = requests.post(
            f"{API}/sales",
            json={"amount": 250, "product": f"{MARKER}-owndel", "notes": f"{MARKER}"},
            headers=_h(emp_tokens["emp1"]),
        )
        assert r.status_code == 200
        sid = r.json()["id"]
        d = requests.delete(f"{API}/sales/{sid}", headers=_h(emp_tokens["emp1"]))
        assert d.status_code in (401, 403), f"owner must not delete sale: {d.status_code}"
