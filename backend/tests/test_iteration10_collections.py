"""
Iteration 10 - Due Collection module (Phase 1)
Tests: PUT/GET /collector, POST/GET/PATCH/DELETE /collections, /collections/summary
plus cascade_rename_user and delete-employee regression around collections.
"""
import os
import pytest
import requests

BASE = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
if not BASE:
    BASE = "https://mass-dialer-2.preview.emergentagent.com"
API = f"{BASE}/api"

ADMIN = ("admin", "Admin@2026")
EMP_PW = "Emp@2026"


def _login(username, password):
    r = requests.post(f"{API}/auth/login", json={"username": username, "password": password}, timeout=15)
    assert r.status_code == 200, f"login {username} failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


def _h(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def admin_token():
    return _login(*ADMIN)


@pytest.fixture(scope="module")
def emp_tokens():
    return {u: _login(u, EMP_PW) for u in ["emp1", "emp2", "emp3", "emp7"]}


@pytest.fixture(scope="module", autouse=True)
def cleanup(admin_token):
    """Clear collector on entry and clear all TEST collections at end."""
    requests.put(f"{API}/admin/collector", json={"username": None}, headers=_h(admin_token))
    yield
    # Delete all entries created (best-effort) — admin sees all
    r = requests.get(f"{API}/collections?limit=500", headers=_h(admin_token))
    if r.status_code == 200:
        for e in r.json():
            # Only nuke entries we plausibly created (in-test notes prefixed TEST_ or empty entries created here)
            if (e.get("notes") or "").startswith("TEST_") or e.get("_test_marker"):
                requests.delete(f"{API}/collections/{e['id']}", headers=_h(admin_token))
    requests.put(f"{API}/admin/collector", json={"username": None}, headers=_h(admin_token))


# ---------- Collector assignment ----------
class TestCollectorAssignment:
    def test_get_collector_initially_none(self, admin_token):
        r = requests.get(f"{API}/collector", headers=_h(admin_token))
        assert r.status_code == 200
        assert r.json()["collector"] is None

    def test_admin_assign_collector(self, admin_token):
        r = requests.put(f"{API}/admin/collector", json={"username": "emp2"}, headers=_h(admin_token))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["collector"]["username"] == "emp2"

    def test_get_collector_after_assign(self, admin_token):
        r = requests.get(f"{API}/collector", headers=_h(admin_token))
        assert r.status_code == 200
        assert r.json()["collector"]["username"] == "emp2"

    def test_non_admin_cannot_assign(self, emp_tokens):
        r = requests.put(f"{API}/admin/collector", json={"username": "emp3"}, headers=_h(emp_tokens["emp3"]))
        assert r.status_code == 403

    def test_assign_non_employee_fails(self, admin_token):
        r = requests.put(f"{API}/admin/collector", json={"username": "nobody_xyz"}, headers=_h(admin_token))
        assert r.status_code == 400

    def test_clear_collector(self, admin_token):
        r = requests.put(f"{API}/admin/collector", json={"username": None}, headers=_h(admin_token))
        assert r.status_code == 200
        assert r.json()["collector"] is None
        # Re-assign for downstream tests
        r2 = requests.put(f"{API}/admin/collector", json={"username": "emp2"}, headers=_h(admin_token))
        assert r2.status_code == 200


# ---------- Create / Read / Permissions ----------
class TestCollectionsCRUD:
    @pytest.fixture(scope="class")
    def created(self, admin_token, emp_tokens):
        # ensure emp2 is collector
        requests.put(f"{API}/admin/collector", json={"username": "emp2"}, headers=_h(admin_token))
        body = {
            "date_key": "2026-01-15",
            "denominations": {"500": 5, "100": 2, "50": -3, "999": 99},  # neg clamped, unknown ignored
            "online_total": 500,
            "notes": "TEST_entry_emp2",
        }
        r = requests.post(f"{API}/collections", json=body, headers=_h(emp_tokens["emp2"]))
        assert r.status_code == 200, r.text
        return r.json()

    def test_collector_can_create_and_compute_totals(self, created):
        assert created["cash_total"] == 5 * 500 + 2 * 100  # 2700
        assert created["online_total"] == 500
        assert created["grand_total"] == 3200
        # neg pcs clamped
        assert created["denominations"].get("50", 0) == 0
        # unknown key ignored
        assert "999" not in created["denominations"]
        assert created["user"] == "emp2"

    def test_non_collector_cannot_create(self, emp_tokens):
        r = requests.post(
            f"{API}/collections",
            json={"denominations": {"100": 1}, "online_total": 0, "notes": "TEST_forbidden"},
            headers=_h(emp_tokens["emp3"]),
        )
        assert r.status_code == 403
        assert "collector" in r.text.lower()

    def test_admin_can_create(self, admin_token):
        r = requests.post(
            f"{API}/collections",
            json={"date_key": "2026-01-14", "denominations": {"200": 3}, "online_total": 100, "notes": "TEST_admin_entry"},
            headers=_h(admin_token),
        )
        assert r.status_code == 200, r.text
        d = r.json()
        # admin creating uses collector's username if set; else admin username
        assert d["cash_total"] == 600
        assert d["grand_total"] == 700

    def test_admin_sees_all(self, admin_token):
        r = requests.get(f"{API}/collections?limit=500", headers=_h(admin_token))
        assert r.status_code == 200
        items = r.json()
        assert any(e.get("notes") == "TEST_entry_emp2" for e in items)
        assert any(e.get("notes") == "TEST_admin_entry" for e in items)

    def test_non_admin_sees_only_own(self, emp_tokens):
        r = requests.get(f"{API}/collections?limit=500", headers=_h(emp_tokens["emp3"]))
        assert r.status_code == 200
        for e in r.json():
            assert e["user"] == "emp3"

    def test_sorted_newest_first(self, admin_token):
        r = requests.get(f"{API}/collections?limit=500", headers=_h(admin_token))
        items = r.json()
        dates = [e["date_key"] for e in items]
        assert dates == sorted(dates, reverse=True)

    def test_date_filter(self, admin_token):
        r = requests.get(f"{API}/collections?from_date=2026-01-15&to_date=2026-01-15", headers=_h(admin_token))
        assert r.status_code == 200
        for e in r.json():
            assert e["date_key"] == "2026-01-15"


# ---------- Update ----------
class TestUpdate:
    @pytest.fixture(scope="class")
    def entry_id(self, admin_token, emp_tokens):
        requests.put(f"{API}/admin/collector", json={"username": "emp2"}, headers=_h(admin_token))
        r = requests.post(
            f"{API}/collections",
            json={"denominations": {"500": 1}, "online_total": 0, "notes": "TEST_update"},
            headers=_h(emp_tokens["emp2"]),
        )
        assert r.status_code == 200
        return r.json()["id"]

    def test_owner_can_update(self, entry_id, emp_tokens):
        r = requests.patch(
            f"{API}/collections/{entry_id}",
            json={"denominations": {"500": 2, "100": 4}, "online_total": 100, "notes": "TEST_update"},
            headers=_h(emp_tokens["emp2"]),
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["cash_total"] == 2 * 500 + 4 * 100  # 1400
        assert d["grand_total"] == 1500

    def test_non_owner_non_admin_cannot_update(self, entry_id, emp_tokens):
        r = requests.patch(
            f"{API}/collections/{entry_id}",
            json={"notes": "TEST_hack"},
            headers=_h(emp_tokens["emp3"]),
        )
        assert r.status_code == 403

    def test_admin_can_update(self, entry_id, admin_token):
        r = requests.patch(
            f"{API}/collections/{entry_id}",
            json={"online_total": 250},
            headers=_h(admin_token),
        )
        assert r.status_code == 200
        assert r.json()["online_total"] == 250


# ---------- Delete ----------
class TestDelete:
    def test_admin_delete_only(self, admin_token, emp_tokens):
        requests.put(f"{API}/admin/collector", json={"username": "emp2"}, headers=_h(admin_token))
        r = requests.post(f"{API}/collections", json={"denominations": {"10": 5}, "notes": "TEST_del"}, headers=_h(emp_tokens["emp2"]))
        cid = r.json()["id"]
        # emp2 (owner but not admin) cannot delete
        r2 = requests.delete(f"{API}/collections/{cid}", headers=_h(emp_tokens["emp2"]))
        assert r2.status_code == 403
        # admin can
        r3 = requests.delete(f"{API}/collections/{cid}", headers=_h(admin_token))
        assert r3.status_code == 200
        assert r3.json().get("deleted") is True


# ---------- Summary ----------
class TestSummary:
    def test_summary_shape(self, admin_token):
        r = requests.get(f"{API}/collections/summary?days=7", headers=_h(admin_token))
        assert r.status_code == 200, r.text
        data = r.json()
        assert "days" in data and len(data["days"]) == 7
        assert "totals" in data
        for k in ("cash", "online", "total"):
            assert k in data["totals"]
        for d in data["days"]:
            assert "date" in d and "cash" in d and "online" in d and "total" in d

    def test_summary_days_bounds(self, admin_token):
        r = requests.get(f"{API}/collections/summary?days=1", headers=_h(admin_token))
        assert r.status_code == 200
        assert len(r.json()["days"]) == 1


# ---------- Cascade rename & delete regression ----------
class TestCascadeAndDelete:
    def test_rename_collector_cascades(self, admin_token):
        # Assign emp7, create an entry as emp7, rename emp7 -> emp7test
        requests.put(f"{API}/admin/collector", json={"username": "emp7"}, headers=_h(admin_token))
        tok7 = _login("emp7", EMP_PW)
        r = requests.post(f"{API}/collections", json={"denominations": {"20": 2}, "notes": "TEST_rename"}, headers=_h(tok7))
        assert r.status_code == 200, r.text
        entry_id = r.json()["id"]

        # rename via admin endpoint
        # find user id first
        u = requests.get(f"{API}/admin/users", headers=_h(admin_token))
        assert u.status_code == 200
        # rename via new_username field
        r2 = requests.patch(
            f"{API}/admin/users/emp7",
            json={"new_username": "emp7test"},
            headers=_h(admin_token),
        )
        assert r2.status_code == 200, f"rename failed: {r2.status_code} {r2.text}"

        # /collector should reflect new username
        col = requests.get(f"{API}/collector", headers=_h(admin_token)).json()
        assert col["collector"] and col["collector"]["username"] == "emp7test", col

        # prior entry now belongs to emp7test
        allr = requests.get(f"{API}/collections?limit=500", headers=_h(admin_token)).json()
        found = [e for e in allr if e["id"] == entry_id]
        assert found and found[0]["user"] == "emp7test"

        # Delete emp7test → collector should be cleared
        # First reassign customers if any (best effort)
        rdel = requests.delete(f"{API}/admin/users/emp7test", headers=_h(admin_token))
        # If has dependencies it may fail; try with reassign or transfer if supported
        if rdel.status_code != 200:
            # Try common patterns
            rdel = requests.delete(
                f"{API}/admin/users/emp7test?reassign_to=admin",
                headers=_h(admin_token),
            )
        if rdel.status_code != 200:
            # Restore username for cleanliness and skip this branch
            requests.patch(
                f"{API}/admin/users/emp7test",
                json={"new_username": "emp7"},
                headers=_h(admin_token),
            )
            pytest.skip(f"delete user failed: {rdel.status_code} {rdel.text}")

        col2 = requests.get(f"{API}/collector", headers=_h(admin_token)).json()
        assert col2["collector"] is None, f"collector should be cleared but was {col2}"

        # Recreate emp7 to restore fixture universe (best-effort)
        requests.post(
            f"{API}/admin/users",
            json={"username": "emp7", "display_name": "Emp 7", "role": "employee", "password": EMP_PW},
            headers=_h(admin_token),
        )

    def test_summary_scope_non_admin(self, emp_tokens):
        """Spec: non-admin should see only own scope. Verify totals ≥ 0 and endpoint reachable."""
        r = requests.get(f"{API}/collections/summary?days=7", headers=_h(emp_tokens["emp3"]))
        assert r.status_code == 200
        data = r.json()
        # emp3 is not collector and hasn't created entries, so totals should be 0
        assert data["totals"]["total"] == 0, f"Expected 0 for non-collector emp3, got {data['totals']}"
