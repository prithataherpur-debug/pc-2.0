"""Iteration 5 — tests for:
   (1) GET /api/customers/lookup?phone=X
   (2) GET /api/admin/team-stats
   (3) PATCH /api/admin/users/{username} with daily_goal
   (4) /stats/today uses custom daily_goal
   (5) /stats/leaderboard uses per-user daily_goal
"""
import os
import time
import pytest
import requests

BASE = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
API = f"{BASE}/api"
RUN = str(int(time.time()))[-6:]


def _h(t):
    return {"Authorization": f"Bearer {t}", "Content-Type": "application/json"}


def _login(user, pw):
    r = requests.post(f"{API}/auth/login", json={"username": user, "password": pw})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_token():
    return _login("admin", "Admin@2026")


@pytest.fixture(scope="module")
def emp7_token():
    return _login("emp7", "Emp@2026")


@pytest.fixture(scope="module")
def default_goal(admin_token):
    r = requests.get(f"{API}/settings", headers=_h(admin_token))
    if r.status_code == 200:
        return r.json().get("daily_goal", 50)
    return 50


# ============ (1) /customers/lookup ============
class TestCustomerLookup:
    _created_id = None

    def test_lookup_requires_auth(self):
        r = requests.get(f"{API}/customers/lookup?phone=9998887777")
        assert r.status_code == 401

    def test_lookup_invalid_phone(self, emp7_token):
        r = requests.get(f"{API}/customers/lookup?phone=abc", headers=_h(emp7_token))
        assert r.status_code == 400

    def test_lookup_not_found(self, emp7_token):
        # A random unlikely phone
        r = requests.get(f"{API}/customers/lookup?phone=+15550000{RUN}", headers=_h(emp7_token))
        assert r.status_code == 200
        d = r.json()
        assert d.get("exists") is False

    def test_lookup_existing_is_mine_true(self, emp7_token):
        # Create as emp7
        name = f"TEST_Dup_{RUN}"
        phone = f"+91 99988{RUN}"
        r = requests.post(f"{API}/customers", headers=_h(emp7_token),
                          json={"name": name, "phone": phone})
        assert r.status_code == 200, r.text
        TestCustomerLookup._created_id = r.json()["id"]

        # Same emp7 looks up: is_mine=True
        r2 = requests.get(f"{API}/customers/lookup?phone={phone}", headers=_h(emp7_token))
        assert r2.status_code == 200, r2.text
        d = r2.json()
        assert d["exists"] is True
        c = d["customer"]
        assert c["name"] == name
        assert c["is_mine"] is True
        assert c.get("assigned_to") == "emp7"

    def test_lookup_existing_is_mine_false_for_other(self, admin_token):
        # emp1 looking at emp7's customer
        emp1 = _login("emp1", "Emp@2026")
        phone = f"+91 99988{RUN}"
        r = requests.get(f"{API}/customers/lookup?phone={phone}", headers=_h(emp1))
        assert r.status_code == 200
        d = r.json()
        assert d["exists"] is True
        assert d["customer"]["is_mine"] is False

    def test_zzz_cleanup(self, admin_token):
        cid = TestCustomerLookup._created_id
        if cid:
            requests.delete(f"{API}/customers/{cid}", headers=_h(admin_token))


# ============ (2) /admin/team-stats ============
class TestTeamStats:
    def test_non_admin_forbidden(self, emp7_token):
        r = requests.get(f"{API}/admin/team-stats", headers=_h(emp7_token))
        assert r.status_code == 403

    def test_requires_auth(self):
        r = requests.get(f"{API}/admin/team-stats")
        assert r.status_code == 401

    def test_admin_ok_shape(self, admin_token, default_goal):
        r = requests.get(f"{API}/admin/team-stats", headers=_h(admin_token))
        assert r.status_code == 200, r.text
        d = r.json()
        assert "date" in d and "default_goal" in d and "rows" in d
        assert d["default_goal"] == default_goal
        rows = d["rows"]
        assert len(rows) == 7  # 7 seeded employees
        need = {"id", "username", "display_name", "daily_goal", "is_custom_goal",
                "calls", "pct", "sales_count", "revenue", "attendance",
                "check_in", "check_out", "customers_total"}
        for row in rows:
            missing = need - row.keys()
            assert not missing, f"row missing keys {missing}: {row}"
            assert row["attendance"] in ("absent", "active", "done")
            assert isinstance(row["daily_goal"], int)
            assert isinstance(row["calls"], int)
            assert isinstance(row["sales_count"], int)
            assert 0.0 <= row["pct"] <= 1.0
            assert isinstance(row["is_custom_goal"], bool)


# ============ (3) PATCH admin/users daily_goal ============
class TestDailyGoalPatch:
    def test_low_bound(self, admin_token):
        r = requests.patch(f"{API}/admin/users/emp3", headers=_h(admin_token),
                           json={"daily_goal": 0})
        assert r.status_code == 400

    def test_high_bound(self, admin_token):
        r = requests.patch(f"{API}/admin/users/emp3", headers=_h(admin_token),
                           json={"daily_goal": 1001})
        assert r.status_code == 400

    def test_set_and_reflect_in_users_list(self, admin_token, default_goal):
        # Set emp3 goal = default+7
        target = default_goal + 7
        r = requests.patch(f"{API}/admin/users/emp3", headers=_h(admin_token),
                           json={"daily_goal": target})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("daily_goal") == target

        # Verify in admin/users list
        lst = requests.get(f"{API}/admin/users", headers=_h(admin_token)).json()
        emp3 = [u for u in lst if u["username"] == "emp3"][0]
        assert emp3.get("daily_goal") == target

        # Verify in team-stats
        ts = requests.get(f"{API}/admin/team-stats", headers=_h(admin_token)).json()
        emp3ts = [r for r in ts["rows"] if r["username"] == "emp3"][0]
        assert emp3ts["daily_goal"] == target
        assert emp3ts["is_custom_goal"] is True

        # Verify in leaderboard (emp3 goal column)
        lb = requests.get(f"{API}/stats/leaderboard", headers=_h(admin_token)).json()
        emp3lb = [r for r in lb["rows"] if r["username"] == "emp3"][0]
        assert emp3lb["goal"] == target

    def test_combined_display_name_and_daily_goal(self, admin_token, default_goal):
        target = default_goal + 3
        new_name = f"Emp3_TEST_{RUN}"
        r = requests.patch(f"{API}/admin/users/emp3", headers=_h(admin_token),
                           json={"display_name": new_name, "daily_goal": target})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("daily_goal") == target
        assert d.get("display_name") == new_name

    def test_stats_today_uses_custom_goal_for_emp3(self, default_goal):
        emp3 = _login("emp3", "Emp@2026")
        r = requests.get(f"{API}/stats/today", headers=_h(emp3))
        assert r.status_code == 200
        # emp3 should now have the custom goal
        expected_goal = default_goal + 3  # from prior test
        assert r.json()["goal"] == expected_goal

    def test_zzz_restore(self, admin_token):
        # Restore emp3: remove custom daily_goal + reset display_name
        # daily_goal cannot be unset via PATCH (no explicit clear API). But we can
        # at least restore display_name. The test contract says leaving blank uses
        # default — but the API always sets when provided. Restore display_name only.
        requests.patch(f"{API}/admin/users/emp3", headers=_h(admin_token),
                       json={"display_name": "Employee 3"})


# ============ (4) /stats/today custom goal ============
class TestStatsTodayGoal:
    def test_default_when_no_custom(self, default_goal):
        # emp5 should not have custom goal set (assume clean state)
        emp5 = _login("emp5", "Emp@2026")
        r = requests.get(f"{API}/stats/today", headers=_h(emp5))
        assert r.status_code == 200
        # emp5 is not modified in this run; expect default
        assert r.json()["goal"] == default_goal

    def test_custom_flows_through(self, admin_token, default_goal):
        # Set emp6 to custom
        custom = default_goal + 12
        r = requests.patch(f"{API}/admin/users/emp6", headers=_h(admin_token),
                           json={"daily_goal": custom})
        assert r.status_code == 200
        emp6 = _login("emp6", "Emp@2026")
        r2 = requests.get(f"{API}/stats/today", headers=_h(emp6))
        assert r2.status_code == 200
        assert r2.json()["goal"] == custom


# ============ (5) /stats/leaderboard per-user goal ============
class TestLeaderboardGoal:
    def test_each_row_reflects_user_goal(self, admin_token, default_goal):
        # Ensure emp6 has a custom, emp5 no custom
        custom6 = default_goal + 12
        # Confirm emp6 custom
        requests.patch(f"{API}/admin/users/emp6", headers=_h(admin_token),
                       json={"daily_goal": custom6})
        lb = requests.get(f"{API}/stats/leaderboard", headers=_h(admin_token)).json()
        emp6 = [r for r in lb["rows"] if r["username"] == "emp6"][0]
        assert emp6["goal"] == custom6

    def test_pct_computed_from_own_goal(self, admin_token):
        lb = requests.get(f"{API}/stats/leaderboard", headers=_h(admin_token)).json()
        for row in lb["rows"]:
            if row["goal"]:
                expected = min(1.0, row["total"] / row["goal"])
                assert abs(row["pct"] - expected) < 1e-6


# ============ Regression ============
class TestRegression:
    def test_admin_login(self):
        assert _login("admin", "Admin@2026")

    def test_emp7_login(self):
        assert _login("emp7", "Emp@2026")

    def test_customers_list(self, emp7_token):
        r = requests.get(f"{API}/customers?scope=mine", headers=_h(emp7_token))
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_admin_users_list(self, admin_token):
        r = requests.get(f"{API}/admin/users", headers=_h(admin_token))
        assert r.status_code == 200
        assert len(r.json()) == 8  # 1 admin + 7 emps

    def test_patch_display_name_still_works(self, admin_token):
        r = requests.patch(f"{API}/admin/users/emp4", headers=_h(admin_token),
                           json={"display_name": f"Emp4_R_{RUN}"})
        assert r.status_code == 200
        assert r.json()["display_name"] == f"Emp4_R_{RUN}"
        # restore
        requests.patch(f"{API}/admin/users/emp4", headers=_h(admin_token),
                       json={"display_name": "Employee 4"})

    def test_patch_empty_payload(self, admin_token):
        r = requests.patch(f"{API}/admin/users/emp4", headers=_h(admin_token), json={})
        assert r.status_code == 400
