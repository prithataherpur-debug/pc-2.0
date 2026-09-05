"""Iteration 7 — Admin user management endpoints.

Covers:
 - POST /api/admin/users (create employee) with validation & auth
 - PATCH /api/admin/users/{username} with new_username, cascade rename
 - DELETE /api/admin/users/{username} with reassign_to
 - Login regression after rename (old fails 401, new works)
 - Admin self-rename & password change, then restore back to seed
"""
import os
import time
import pytest
import requests

BASE = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
API = f"{BASE}/api"
RUN = str(int(time.time()))[-5:]

ADMIN_U = "admin"
ADMIN_P = "Admin@2026"
EMP_P = "Emp@2026"

# Unique per-run usernames, prefixed with zztest for easy cleanup
U1 = f"zztest{RUN}a"   # new employee to create
U1_RENAMED = f"zztest{RUN}b"   # after rename
U_DEL = f"zztest{RUN}c"        # to delete (with customers)
U_TARGET = "emp1"              # reassign target


def _h(t):
    return {"Authorization": f"Bearer {t}", "Content-Type": "application/json"}


def _login(u, p):
    r = requests.post(f"{API}/auth/login", json={"username": u, "password": p})
    return r


@pytest.fixture(scope="module")
def admin_token():
    r = _login(ADMIN_U, ADMIN_P)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def emp1_token():
    r = _login("emp1", EMP_P)
    assert r.status_code == 200
    return r.json()["access_token"]


# ============ Cleanup helper — module teardown ============
@pytest.fixture(scope="module", autouse=True)
def _cleanup(admin_token):
    yield
    # Best-effort delete of any test-created users still around
    for u in [U1, U1_RENAMED, U_DEL]:
        try:
            requests.delete(f"{API}/admin/users/{u}", headers=_h(admin_token),
                            params={"reassign_to": U_TARGET})
        except Exception:
            pass


# ================= POST /admin/users =================
class TestAdminCreate:
    def test_non_admin_forbidden(self, emp1_token):
        r = requests.post(f"{API}/admin/users",
                          headers=_h(emp1_token),
                          json={"username": U1, "password": "pass1234"})
        assert r.status_code == 403

    def test_invalid_username_format(self, admin_token):
        r = requests.post(f"{API}/admin/users",
                          headers=_h(admin_token),
                          json={"username": "ab", "password": "pass1234"})
        assert r.status_code == 400
        assert "3-30" in r.json()["detail"]

    def test_short_password(self, admin_token):
        r = requests.post(f"{API}/admin/users",
                          headers=_h(admin_token),
                          json={"username": U1, "password": "ab"})
        assert r.status_code == 400

    def test_create_success(self, admin_token):
        r = requests.post(f"{API}/admin/users",
                          headers=_h(admin_token),
                          json={"username": U1, "password": "pass1234",
                                "display_name": "Zz Tester", "daily_goal": 25})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["username"] == U1
        assert body["role"] == "employee"
        assert body["display_name"] == "Zz Tester"
        assert body.get("daily_goal") == 25

    def test_duplicate_username(self, admin_token):
        r = requests.post(f"{API}/admin/users",
                          headers=_h(admin_token),
                          json={"username": U1, "password": "pass1234"})
        assert r.status_code == 409

    def test_new_employee_can_login(self):
        r = _login(U1, "pass1234")
        assert r.status_code == 200
        assert r.json()["user"]["username"] == U1


# ================= PATCH /admin/users with new_username + cascade =================
class TestCascadeRename:
    customer_id = None
    sale_id = None

    def test_seed_customer_and_sale_under_U1(self, admin_token):
        # Create a customer assigned to U1
        r = requests.post(f"{API}/customers",
                          headers=_h(admin_token),
                          json={
                              "name": f"TEST_Rename_{RUN}",
                              "phone": f"+91 99{RUN}00001",
                              "assigned_to": U1,
                          })
        assert r.status_code == 200, r.text
        TestCascadeRename.customer_id = r.json()["id"]

        # Log a sale as U1
        u1_tok = _login(U1, "pass1234").json()["access_token"]
        r2 = requests.post(f"{API}/sales", headers=_h(u1_tok),
                           json={"customer_id": TestCascadeRename.customer_id,
                                 "amount": 999, "product": "TESTPROD"})
        assert r2.status_code == 200, r2.text
        TestCascadeRename.sale_id = r2.json().get("id")

    def test_rename_with_password_and_goal(self, admin_token):
        r = requests.patch(f"{API}/admin/users/{U1}",
                           headers=_h(admin_token),
                           json={"new_username": U1_RENAMED,
                                 "password": "newpass99",
                                 "daily_goal": 42})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["username"] == U1_RENAMED
        assert body.get("daily_goal") == 42

    def test_old_username_login_fails(self):
        r = _login(U1, "pass1234")
        assert r.status_code == 401
        r2 = _login(U1, "newpass99")
        assert r2.status_code == 401

    def test_new_username_login_works(self):
        r = _login(U1_RENAMED, "newpass99")
        assert r.status_code == 200

    def test_customer_assigned_to_new_username(self, admin_token):
        r = requests.get(f"{API}/customers",
                         headers=_h(admin_token),
                         params={"scope": "all"})
        assert r.status_code == 200
        found = [c for c in r.json() if c["id"] == TestCascadeRename.customer_id]
        assert len(found) == 1
        assert found[0]["assigned_to"] == U1_RENAMED

    def test_sale_user_updated(self, admin_token):
        # Get sales list — must show the renamed username
        r = requests.get(f"{API}/sales", headers=_h(admin_token),
                         params={"scope": "all"})
        assert r.status_code == 200
        sales = r.json()
        mine = [s for s in sales if s.get("id") == TestCascadeRename.sale_id]
        assert len(mine) == 1
        assert mine[0]["user"] == U1_RENAMED

    def test_rename_duplicate_conflict(self, admin_token):
        r = requests.patch(f"{API}/admin/users/{U1_RENAMED}",
                           headers=_h(admin_token),
                           json={"new_username": "emp1"})
        assert r.status_code == 409

    def test_rename_invalid_format(self, admin_token):
        r = requests.patch(f"{API}/admin/users/{U1_RENAMED}",
                           headers=_h(admin_token),
                           json={"new_username": "xx"})
        assert r.status_code == 400


# ================= DELETE /admin/users =================
class TestAdminDelete:
    def test_cannot_delete_admin(self, admin_token):
        r = requests.delete(f"{API}/admin/users/admin", headers=_h(admin_token))
        assert r.status_code == 400
        assert "admin" in r.json()["detail"].lower()

    def test_non_admin_forbidden(self, emp1_token):
        r = requests.delete(f"{API}/admin/users/emp2", headers=_h(emp1_token))
        assert r.status_code == 403

    def test_not_found(self, admin_token):
        r = requests.delete(f"{API}/admin/users/nosuchuser_xyz",
                            headers=_h(admin_token))
        assert r.status_code == 404

    def test_delete_requires_reassign_when_customers(self, admin_token):
        # Create emp U_DEL and assign a customer to them
        r = requests.post(f"{API}/admin/users",
                          headers=_h(admin_token),
                          json={"username": U_DEL, "password": "pass1234"})
        assert r.status_code == 200
        r2 = requests.post(f"{API}/customers",
                           headers=_h(admin_token),
                           json={"name": f"TEST_Del_{RUN}",
                                 "phone": f"+91 99{RUN}00002",
                                 "assigned_to": U_DEL})
        assert r2.status_code == 200

        # Delete without reassign_to → 400
        r3 = requests.delete(f"{API}/admin/users/{U_DEL}",
                             headers=_h(admin_token))
        assert r3.status_code == 400
        assert "reassign" in r3.json()["detail"].lower()

        # Delete with valid reassign_to → 200
        r4 = requests.delete(f"{API}/admin/users/{U_DEL}",
                             headers=_h(admin_token),
                             params={"reassign_to": U_TARGET})
        assert r4.status_code == 200, r4.text
        j = r4.json()
        assert j["deleted"] == U_DEL
        assert j["customers_moved"] >= 1
        assert j["reassigned_to"] == U_TARGET

    def test_deleted_user_cannot_login(self):
        r = _login(U_DEL, "pass1234")
        assert r.status_code == 401

    def test_customers_now_belong_to_target(self, admin_token):
        r = requests.get(f"{API}/customers",
                         headers=_h(admin_token),
                         params={"scope": "all"})
        assert r.status_code == 200
        # The test customer created for U_DEL should now be assigned to U_TARGET
        matches = [c for c in r.json() if c.get("name") == f"TEST_Del_{RUN}"]
        assert len(matches) == 1
        assert matches[0]["assigned_to"] == U_TARGET

    def test_delete_renamed_user_with_customers(self, admin_token):
        # Now delete U1_RENAMED which still has 1 customer + 1 sale
        r = requests.delete(f"{API}/admin/users/{U1_RENAMED}",
                            headers=_h(admin_token),
                            params={"reassign_to": U_TARGET})
        assert r.status_code == 200
        assert r.json()["customers_moved"] >= 1

    def test_cleanup_test_customers(self, admin_token):
        # Delete the two test customers we created via reassignment
        r = requests.get(f"{API}/customers",
                         headers=_h(admin_token),
                         params={"scope": "all"})
        assert r.status_code == 200
        for c in r.json():
            if c.get("name", "").startswith(f"TEST_Rename_{RUN}") or \
               c.get("name", "").startswith(f"TEST_Del_{RUN}"):
                requests.delete(f"{API}/customers/{c['id']}",
                                headers=_h(admin_token))


# ================= Admin self-rename + password change =================
class TestAdminSelf:
    """Rename admin, change pw, verify login, then RESTORE back to seed."""
    NEW_ADMIN = f"zzadmin{RUN}"
    NEW_PW = "AdminNew@99"

    def test_admin_rename_and_pw(self, admin_token):
        r = requests.patch(f"{API}/admin/users/{ADMIN_U}",
                           headers=_h(admin_token),
                           json={"new_username": self.NEW_ADMIN,
                                 "password": self.NEW_PW})
        assert r.status_code == 200
        assert r.json()["username"] == self.NEW_ADMIN

    def test_admin_new_login(self):
        r = _login(self.NEW_ADMIN, self.NEW_PW)
        assert r.status_code == 200, r.text
        assert r.json()["user"]["role"] == "admin"

    def test_admin_old_login_fails(self):
        r = _login(ADMIN_U, ADMIN_P)
        assert r.status_code == 401

    def test_restore_admin(self):
        # Login with new creds, then rename back + reset password → seed state
        tok = _login(self.NEW_ADMIN, self.NEW_PW).json()["access_token"]
        r = requests.patch(f"{API}/admin/users/{self.NEW_ADMIN}",
                           headers=_h(tok),
                           json={"new_username": ADMIN_U,
                                 "password": ADMIN_P})
        assert r.status_code == 200
        # Verify seed login works again
        r2 = _login(ADMIN_U, ADMIN_P)
        assert r2.status_code == 200
