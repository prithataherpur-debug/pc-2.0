"""CallFlow CRM backend API tests — multi-user JWT edition."""
import os
import time
import pytest
import requests
from datetime import datetime, timezone, timedelta

BASE = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
API = f"{BASE}/api"

# unique per-run suffix so re-runs don't collide on unique phone index
RUN = str(int(time.time()))[-6:]


def _no_id(obj):
    if isinstance(obj, dict):
        assert "_id" not in obj, f"leaked _id: {obj}"
        for v in obj.values():
            _no_id(v)
    elif isinstance(obj, list):
        for v in obj:
            _no_id(v)


# ----------------- fixtures -----------------
@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"username": "admin", "password": "Admin@2026"})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def emp1_token():
    r = requests.post(f"{API}/auth/login", json={"username": "emp1", "password": "Emp@2026"})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def emp2_token():
    r = requests.post(f"{API}/auth/login", json={"username": "emp2", "password": "Emp@2026"})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def h(t):
    return {"Authorization": f"Bearer {t}", "Content-Type": "application/json"}


# ----------------- Auth -----------------
class TestAuth:
    def test_login_admin_ok(self):
        r = requests.post(f"{API}/auth/login", json={"username": "admin", "password": "Admin@2026"})
        assert r.status_code == 200
        d = r.json()
        assert "access_token" in d and d["user"]["role"] == "admin"
        _no_id(d)

    def test_login_wrong_password(self):
        r = requests.post(f"{API}/auth/login", json={"username": "admin", "password": "wrong"})
        assert r.status_code == 401

    def test_me_ok(self, admin_token):
        r = requests.get(f"{API}/auth/me", headers=h(admin_token))
        assert r.status_code == 200
        assert r.json()["username"] == "admin"

    def test_me_no_token(self):
        r = requests.get(f"{API}/auth/me")
        assert r.status_code == 401

    def test_login_all_employees(self):
        for i in range(1, 8):
            r = requests.post(f"{API}/auth/login", json={"username": f"emp{i}", "password": "Emp@2026"})
            assert r.status_code == 200, f"emp{i} failed: {r.text}"
            assert r.json()["user"]["role"] == "employee"


# ----------------- Users / RBAC -----------------
class TestUsers:
    def test_admin_lists_users(self, admin_token):
        r = requests.get(f"{API}/admin/users", headers=h(admin_token))
        assert r.status_code == 200
        arr = r.json()
        usernames = {u["username"] for u in arr}
        assert "admin" in usernames
        for i in range(1, 8):
            assert f"emp{i}" in usernames
        _no_id(arr)

    def test_employee_forbidden_admin_users(self, emp1_token):
        r = requests.get(f"{API}/admin/users", headers=h(emp1_token))
        assert r.status_code == 403


# ----------------- Customers -----------------
class TestCustomers:
    created_ids = []

    def test_employee_create_auto_assigns_self(self, emp1_token):
        r = requests.post(
            f"{API}/customers",
            headers=h(emp1_token),
            json={"name": "TEST_Emp1Cust", "phone": f"+91-9990-{RUN}"},
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["assigned_to"] == "emp1"
        TestCustomers.created_ids.append(d["id"])

    def test_duplicate_phone_conflict(self, emp1_token):
        r = requests.post(
            f"{API}/customers",
            headers=h(emp1_token),
            json={"name": "TEST_Dup", "phone": f"919990{RUN}"},  # same digits: 919990000101
        )
        assert r.status_code == 409

    def test_scope_mine_only(self, emp1_token):
        r = requests.get(f"{API}/customers?scope=mine", headers=h(emp1_token))
        assert r.status_code == 200
        for c in r.json():
            assert c["assigned_to"] == "emp1"

    def test_admin_scope_all(self, admin_token):
        r = requests.get(f"{API}/customers?scope=all", headers=h(admin_token))
        assert r.status_code == 200
        arr = r.json()
        owners = {c["assigned_to"] for c in arr}
        # bulk imports round-robined across 7 employees
        assert len(owners) >= 2

    def test_bulk_round_robin_and_dedupe(self, admin_token):
        payload = {"customers": [
            {"name": f"TEST_RR_{i}", "phone": f"+91 700-{RUN}-0{i:03d}"} for i in range(14)
        ] + [
            {"name": "TEST_Dup_A", "phone": f"91 700 {RUN} 0000"},  # matches i=0 (917001000000)
        ]}
        r = requests.post(f"{API}/customers/bulk", headers=h(admin_token), json=payload)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["inserted"] == 14
        assert d["duplicates"] == 1

        # verify round-robin across 7 employees
        r2 = requests.get(f"{API}/customers?scope=all&search=TEST_RR_", headers=h(admin_token))
        rr = r2.json()
        owners = [c["assigned_to"] for c in rr]
        assert len(set(owners)) == 7, f"expected 7 owners got {set(owners)}"

        # cleanup: track ids
        for c in rr:
            TestCustomers.created_ids.append(c["id"])


# ----------------- Status / feedback -----------------
class TestStatusFeedback:
    def test_interested_sets_followup_and_logs(self, emp1_token):
        # create a customer to work with
        c = requests.post(f"{API}/customers", headers=h(emp1_token),
                          json={"name": "TEST_Interested", "phone": f"+1-555-777-{RUN}1"}).json()
        cid = c["id"]
        r = requests.patch(f"{API}/customers/{cid}/status", headers=h(emp1_token),
                           json={"status": "interested"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["status"] == "interested"
        assert d["followup_date"] is not None
        # Verify follow-up date is in future
        fd = datetime.strptime(d["followup_date"], "%Y-%m-%d").date()
        today = datetime.now(timezone.utc).date()
        assert fd >= today

        # cleanup
        TestCustomers.created_ids.append(cid)

    def test_callback_sets_tomorrow(self, emp1_token):
        c = requests.post(f"{API}/customers", headers=h(emp1_token),
                          json={"name": "TEST_Callback", "phone": f"+1-555-777-{RUN}2"}).json()
        cid = c["id"]
        r = requests.patch(f"{API}/customers/{cid}/status", headers=h(emp1_token),
                           json={"status": "callback"})
        assert r.status_code == 200
        d = r.json()
        expected = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%d")
        assert d["followup_date"] == expected
        TestCustomers.created_ids.append(cid)

    def test_feedback_persists(self, emp1_token):
        c = requests.post(f"{API}/customers", headers=h(emp1_token),
                          json={"name": "TEST_Feedback", "phone": f"+1-555-777-{RUN}3"}).json()
        cid = c["id"]
        r = requests.post(f"{API}/customers/{cid}/feedback", headers=h(emp1_token),
                         json={"rating": 5, "notes": "great"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["rating"] == 5 and d["feedback"] == "great"
        TestCustomers.created_ids.append(cid)

    def test_employee_cannot_update_other_employee_customer(self, emp1_token, emp2_token):
        c = requests.post(f"{API}/customers", headers=h(emp2_token),
                         json={"name": "TEST_Emp2Only", "phone": f"+1-555-888-{RUN}4"}).json()
        cid = c["id"]
        r = requests.patch(f"{API}/customers/{cid}/status", headers=h(emp1_token),
                          json={"status": "interested"})
        assert r.status_code == 404  # scoped, so not found for emp1
        TestCustomers.created_ids.append(cid)


# ----------------- Follow-ups / stats -----------------
class TestFollowupsAndStats:
    def test_followups_scoped(self, emp1_token):
        r = requests.get(f"{API}/followups", headers=h(emp1_token))
        assert r.status_code == 200
        for c in r.json():
            assert c["assigned_to"] == "emp1"
            assert c["status"] in ("interested", "callback")

    def test_stats_today(self, emp1_token):
        r = requests.get(f"{API}/stats/today", headers=h(emp1_token))
        assert r.status_code == 200
        d = r.json()
        assert d["goal"] >= 1
        assert d["total_calls"] >= 1


# ----------------- Reassign -----------------
class TestReassign:
    def test_reassign_ok(self, admin_token, emp1_token):
        c = requests.post(f"{API}/customers", headers=h(emp1_token),
                         json={"name": "TEST_Reassign", "phone": f"+1-555-000-{RUN}5"}).json()
        cid = c["id"]
        r = requests.post(f"{API}/admin/reassign", headers=h(admin_token),
                         json={"customer_ids": [cid], "new_owner": "emp3"})
        assert r.status_code == 200
        assert r.json()["updated"] == 1
        # verify
        r2 = requests.get(f"{API}/customers?scope=all&search=TEST_Reassign",
                         headers=h(admin_token))
        assert any(x["assigned_to"] == "emp3" for x in r2.json())
        TestCustomers.created_ids.append(cid)

    def test_reassign_unknown_owner(self, admin_token):
        r = requests.post(f"{API}/admin/reassign", headers=h(admin_token),
                         json={"customer_ids": [], "new_owner": "ghost"})
        assert r.status_code == 400


# ----------------- Attendance -----------------
class TestAttendance:
    def test_checkin_and_idempotent(self, emp1_token):
        r = requests.post(f"{API}/attendance/check-in", headers=h(emp1_token),
                         json={"latitude": 12.9, "longitude": 77.6, "accuracy": 15})
        assert r.status_code == 200
        d = r.json()
        assert d["user"] == "emp1"
        assert d["check_in_location"]["latitude"] == 12.9
        # second call same day returns existing (possibly same doc)
        r2 = requests.post(f"{API}/attendance/check-in", headers=h(emp1_token),
                          json={"latitude": 99.0, "longitude": 99.0})
        assert r2.status_code == 200
        assert r2.json()["id"] == d["id"]
        _no_id(d)

    def test_checkout_sets_location(self, emp1_token):
        r = requests.post(f"{API}/attendance/check-out", headers=h(emp1_token),
                         json={"latitude": 13.0, "longitude": 77.7})
        assert r.status_code == 200
        d = r.json()
        assert d["check_out"] is not None
        assert d["check_out_location"]["latitude"] == 13.0

    def test_attendance_today(self, emp1_token):
        r = requests.get(f"{API}/attendance/today", headers=h(emp1_token))
        assert r.status_code == 200
        assert len(r.json()["records"]) >= 1

    def test_attendance_history(self, emp1_token):
        r = requests.get(f"{API}/attendance/history", headers=h(emp1_token))
        assert r.status_code == 200
        assert "records" in r.json()


# ----------------- Settings -----------------
class TestSettings:
    def test_get_settings_any(self, emp1_token):
        r = requests.get(f"{API}/settings", headers=h(emp1_token))
        assert r.status_code == 200

    def test_patch_settings_admin_only(self, emp1_token):
        r = requests.patch(f"{API}/settings", headers=h(emp1_token), json={"daily_goal": 999})
        assert r.status_code == 403

    def test_patch_settings_admin_ok(self, admin_token):
        r = requests.patch(f"{API}/settings", headers=h(admin_token),
                          json={"daily_goal": 50, "follow_up_days": 3})
        assert r.status_code == 200
        d = r.json()
        assert d["daily_goal"] == 50 and d["follow_up_days"] == 3


# ----------------- Cleanup -----------------
class TestZCleanup:
    def test_cleanup_test_customers(self, admin_token):
        # delete all TEST_ prefixed customers created above
        for cid in TestCustomers.created_ids:
            requests.delete(f"{API}/customers/{cid}", headers=h(admin_token))
