"""
Iteration 13 — Daybook (Daily Sales cash + Due Collection consolidated view)

Covers backend endpoints:
- POST/GET/PATCH/DELETE /api/daily-sales
- GET /api/daybook?date=YYYY-MM-DD (consolidated + grand totals)
- cascade_rename_user() must migrate db.daily_sales.user
"""

import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN = {"username": "admin", "password": "Admin@2026"}
EMP_PW = "Emp@2026"


# -------------------------- helpers --------------------------
def _login(username: str, password: str) -> str:
    r = requests.post(f"{API}/auth/login", json={"username": username, "password": password}, timeout=15)
    r.raise_for_status()
    return r.json()["access_token"]


def _hdr(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def admin_token():
    return _login(**ADMIN)


@pytest.fixture(scope="module")
def emp1_token():
    return _login("emp1", EMP_PW)


@pytest.fixture(scope="module")
def emp2_token():
    return _login("emp2", EMP_PW)


@pytest.fixture(scope="module")
def cleanup(admin_token):
    """Track daily-sale ids to delete + collection ids created by tests."""
    ds_ids: list[str] = []
    col_ids: list[str] = []
    yield {"ds": ds_ids, "col": col_ids}
    hdr = _hdr(admin_token)
    for i in ds_ids:
        try:
            requests.delete(f"{API}/daily-sales/{i}", headers=hdr, timeout=10)
        except Exception:
            pass
    for i in col_ids:
        try:
            requests.delete(f"{API}/collections/{i}", headers=hdr, timeout=10)
        except Exception:
            pass


# =========================================================
# CREATE
# =========================================================
class TestCreateDailySale:
    def test_health(self):
        r = requests.get(f"{API}/", timeout=10)
        assert r.status_code == 200

    def test_employee_can_create_own(self, emp1_token, cleanup):
        body = {
            "date_key": "2026-01-15",
            "denominations": {"500": 3, "100": 2, "bogus": 99},
            "online_total": 500,
            "notes": "TEST_it13 emp1",
        }
        r = requests.post(f"{API}/daily-sales", headers=_hdr(emp1_token), json=body, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        cleanup["ds"].append(d["id"])
        # 500*3=1500 + 100*2=200 => cash 1700; online 500; grand 2200
        assert d["cash_total"] == 1700
        assert d["online_total"] == 500
        assert d["grand_total"] == 2200
        assert d["user"] == "emp1"
        assert "bogus" not in d["denominations"], "Unknown denomination keys must be ignored"

    def test_negatives_clamped(self, emp1_token, cleanup):
        r = requests.post(
            f"{API}/daily-sales",
            headers=_hdr(emp1_token),
            json={
                "date_key": "2026-01-15",
                "denominations": {"500": -4, "100": 1},
                "online_total": -300,
                "notes": "TEST_it13 clamp",
            },
            timeout=15,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        cleanup["ds"].append(d["id"])
        assert d["cash_total"] == 100, "Negative pcs must be clamped to 0"
        assert d["online_total"] == 0, "Negative online must be clamped to 0"
        assert d["grand_total"] == 100

    def test_admin_can_create_own(self, admin_token, cleanup):
        r = requests.post(
            f"{API}/daily-sales",
            headers=_hdr(admin_token),
            json={
                "date_key": "2026-01-15",
                "denominations": {"200": 5},
                "online_total": 250,
                "notes": "TEST_it13 admin own",
            },
            timeout=15,
        )
        assert r.status_code == 200
        d = r.json()
        cleanup["ds"].append(d["id"])
        assert d["user"] == "admin"
        assert d["cash_total"] == 1000
        assert d["grand_total"] == 1250

    def test_create_persists_and_returned_via_get(self, emp1_token, cleanup):
        r = requests.post(
            f"{API}/daily-sales",
            headers=_hdr(emp1_token),
            json={"date_key": "2026-01-16", "denominations": {"50": 10}, "online_total": 0, "notes": "TEST_it13 persist"},
            timeout=15,
        )
        assert r.status_code == 200
        did = r.json()["id"]
        cleanup["ds"].append(did)
        g = requests.get(f"{API}/daily-sales?from_date=2026-01-16&to_date=2026-01-16", headers=_hdr(emp1_token), timeout=15)
        assert g.status_code == 200
        assert any(x["id"] == did for x in g.json())


# =========================================================
# LIST
# =========================================================
class TestListDailySales:
    @pytest.fixture(autouse=True)
    def _seed(self, admin_token, emp1_token, emp2_token, cleanup):
        # emp1 + emp2 entries on 2026-01-17
        for tok, denoms, online in [
            (emp1_token, {"500": 2}, 100),
            (emp2_token, {"100": 5}, 200),
        ]:
            r = requests.post(
                f"{API}/daily-sales",
                headers=_hdr(tok),
                json={"date_key": "2026-01-17", "denominations": denoms, "online_total": online, "notes": "TEST_it13 list"},
                timeout=15,
            )
            assert r.status_code == 200
            cleanup["ds"].append(r.json()["id"])
        yield

    def test_workspace_wide_default(self, emp1_token):
        r = requests.get(f"{API}/daily-sales?from_date=2026-01-17&to_date=2026-01-17", headers=_hdr(emp1_token), timeout=15)
        assert r.status_code == 200
        users = {e["user"] for e in r.json()}
        assert {"emp1", "emp2"}.issubset(users), f"Expected workspace-wide visibility, got {users}"

    def test_filter_by_user(self, admin_token):
        r = requests.get(f"{API}/daily-sales?user=emp2&from_date=2026-01-17&to_date=2026-01-17", headers=_hdr(admin_token), timeout=15)
        assert r.status_code == 200
        rows = r.json()
        assert rows, "should return emp2 entry"
        assert all(x["user"] == "emp2" for x in rows)

    def test_sorted_newest_first(self, admin_token):
        r = requests.get(f"{API}/daily-sales?limit=20", headers=_hdr(admin_token), timeout=15)
        assert r.status_code == 200
        rows = r.json()
        if len(rows) >= 2:
            # date_key desc, then created_at desc
            dates = [x["date_key"] for x in rows]
            assert dates == sorted(dates, reverse=True)

    def test_display_name_attached(self, admin_token):
        r = requests.get(f"{API}/daily-sales?user=emp1&from_date=2026-01-17&to_date=2026-01-17", headers=_hdr(admin_token), timeout=15)
        assert r.status_code == 200
        rows = r.json()
        assert rows and rows[0].get("display_name")


# =========================================================
# PATCH  (owner OR admin)
# =========================================================
class TestPatchDailySale:
    @pytest.fixture()
    def emp1_entry(self, emp1_token, cleanup):
        r = requests.post(
            f"{API}/daily-sales",
            headers=_hdr(emp1_token),
            json={"date_key": "2026-01-18", "denominations": {"500": 1}, "online_total": 100, "notes": "TEST_it13 patch"},
            timeout=15,
        )
        assert r.status_code == 200
        did = r.json()["id"]
        cleanup["ds"].append(did)
        return did

    def test_owner_can_edit(self, emp1_token, emp1_entry):
        r = requests.patch(
            f"{API}/daily-sales/{emp1_entry}",
            headers=_hdr(emp1_token),
            json={"denominations": {"500": 3}, "online_total": 200},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["cash_total"] == 1500
        assert d["online_total"] == 200
        assert d["grand_total"] == 1700

    def test_admin_can_edit_others(self, admin_token, emp1_entry):
        r = requests.patch(
            f"{API}/daily-sales/{emp1_entry}",
            headers=_hdr(admin_token),
            json={"notes": "TEST_it13 patched by admin"},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        assert r.json()["notes"] == "TEST_it13 patched by admin"

    def test_non_owner_non_admin_forbidden(self, emp2_token, emp1_entry):
        r = requests.patch(
            f"{API}/daily-sales/{emp1_entry}",
            headers=_hdr(emp2_token),
            json={"online_total": 999},
            timeout=15,
        )
        assert r.status_code == 403

    def test_patch_404(self, emp1_token):
        r = requests.patch(
            f"{API}/daily-sales/does-not-exist",
            headers=_hdr(emp1_token),
            json={"online_total": 1},
            timeout=15,
        )
        assert r.status_code == 404


# =========================================================
# DELETE (admin only)
# =========================================================
class TestDeleteDailySale:
    def test_non_admin_forbidden(self, emp1_token, emp2_token, cleanup):
        r = requests.post(
            f"{API}/daily-sales",
            headers=_hdr(emp1_token),
            json={"date_key": "2026-01-19", "denominations": {"100": 1}, "notes": "TEST_it13 del"},
            timeout=15,
        )
        assert r.status_code == 200
        did = r.json()["id"]
        cleanup["ds"].append(did)
        # owner cannot delete
        r2 = requests.delete(f"{API}/daily-sales/{did}", headers=_hdr(emp1_token), timeout=10)
        assert r2.status_code == 403
        # other emp cannot
        r3 = requests.delete(f"{API}/daily-sales/{did}", headers=_hdr(emp2_token), timeout=10)
        assert r3.status_code == 403

    def test_admin_can_delete(self, admin_token, emp1_token):
        r = requests.post(
            f"{API}/daily-sales",
            headers=_hdr(emp1_token),
            json={"date_key": "2026-01-19", "denominations": {"100": 2}, "notes": "TEST_it13 admin-del"},
            timeout=15,
        )
        did = r.json()["id"]
        r2 = requests.delete(f"{API}/daily-sales/{did}", headers=_hdr(admin_token), timeout=10)
        assert r2.status_code == 200
        assert r2.json()["deleted"] is True
        # verify gone
        g = requests.get(f"{API}/daily-sales?from_date=2026-01-19&to_date=2026-01-19", headers=_hdr(admin_token), timeout=15)
        assert all(x["id"] != did for x in g.json())


# =========================================================
# DAYBOOK aggregate
# =========================================================
class TestDaybookAggregate:
    DAY = "2026-01-20"

    @pytest.fixture(autouse=True)
    def _seed_day(self, admin_token, emp1_token, emp2_token, cleanup):
        # Two daily-sale entries on DAY
        r1 = requests.post(
            f"{API}/daily-sales",
            headers=_hdr(emp1_token),
            json={"date_key": self.DAY, "denominations": {"500": 2, "100": 3}, "online_total": 250, "notes": "TEST_it13 db1"},
            timeout=15,
        )
        r2 = requests.post(
            f"{API}/daily-sales",
            headers=_hdr(emp2_token),
            json={"date_key": self.DAY, "denominations": {"200": 4}, "online_total": 100, "notes": "TEST_it13 db2"},
            timeout=15,
        )
        assert r1.status_code == 200 and r2.status_code == 200
        cleanup["ds"].extend([r1.json()["id"], r2.json()["id"]])

        # One collection entry — admin is a collector-or-admin so allowed
        c = requests.post(
            f"{API}/collections",
            headers=_hdr(admin_token),
            json={"date_key": self.DAY, "denominations": {"500": 1}, "online_total": 400, "notes": "TEST_it13 col"},
            timeout=15,
        )
        assert c.status_code == 200, c.text
        cleanup["col"].append(c.json()["id"])
        yield

    def test_daybook_totals(self, emp1_token):
        r = requests.get(f"{API}/daybook?date={self.DAY}", headers=_hdr(emp1_token), timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["date"] == self.DAY
        assert "due_collection" in d and "daily_sales" in d and "grand_total" in d

        # daily-sales expected: (500*2+100*3)+(200*4) = 1300+800 = 2100 cash; online 250+100=350; total 2450
        ds = d["daily_sales"]
        assert ds["cash"] == 2100
        assert ds["online"] == 350
        assert ds["total"] == 2450
        assert len(ds["entries"]) >= 2

        # collection: 500 cash + 400 online = 900
        col = d["due_collection"]
        assert col["cash"] == 500
        assert col["online"] == 400
        assert col["total"] == 900
        assert len(col["entries"]) >= 1

        # Grand = sums
        g = d["grand_total"]
        assert g["cash"] == ds["cash"] + col["cash"]
        assert g["online"] == ds["online"] + col["online"]
        assert g["total"] == ds["total"] + col["total"]

    def test_daybook_default_today_when_no_param(self, emp1_token):
        r = requests.get(f"{API}/daybook", headers=_hdr(emp1_token), timeout=15)
        assert r.status_code == 200
        assert r.json()["date"]  # non-empty

    def test_daybook_requires_auth(self):
        r = requests.get(f"{API}/daybook?date={self.DAY}", timeout=10)
        assert r.status_code in (401, 403)


# =========================================================
# Cascade rename (emp7 → emp7test → emp7)
# =========================================================
class TestCascadeRename:
    def test_rename_migrates_daily_sales(self, admin_token, cleanup):
        emp7_tok = _login("emp7", EMP_PW)
        # Create a daily-sale as emp7
        r = requests.post(
            f"{API}/daily-sales",
            headers=_hdr(emp7_tok),
            json={"date_key": "2026-01-21", "denominations": {"100": 4}, "online_total": 50, "notes": "TEST_it13 rename"},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        did = r.json()["id"]
        cleanup["ds"].append(did)

        # Rename emp7 → emp7test
        rn = requests.patch(
            f"{API}/admin/users/emp7",
            headers=_hdr(admin_token),
            json={"new_username": "emp7test"},
            timeout=15,
        )
        try:
            assert rn.status_code == 200, rn.text

            # Entry must now be attributed to emp7test
            g = requests.get(f"{API}/daily-sales?user=emp7test&from_date=2026-01-21&to_date=2026-01-21", headers=_hdr(admin_token), timeout=15)
            assert g.status_code == 200
            assert any(x["id"] == did and x["user"] == "emp7test" for x in g.json())

            # And not attributed to emp7 anymore
            g2 = requests.get(f"{API}/daily-sales?user=emp7&from_date=2026-01-21&to_date=2026-01-21", headers=_hdr(admin_token), timeout=15)
            assert g2.status_code == 200
            assert all(x["id"] != did for x in g2.json())
        finally:
            # Reset emp7test → emp7 no matter what
            requests.patch(
                f"{API}/admin/users/emp7test",
                headers=_hdr(admin_token),
                json={"new_username": "emp7"},
                timeout=15,
            )
