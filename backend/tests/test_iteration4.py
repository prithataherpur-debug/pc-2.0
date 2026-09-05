"""Iteration 4 backend tests:
- PATCH /api/admin/users/{username}
- POST /api/customers (employee creates via punch-sale-new-customer flow)
- Regression checks on /auth/login, /customers, /sales, /admin/users
"""
import os
import uuid
import pytest
import requests

BASE = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
API = f"{BASE}/api"


def _login(username: str, password: str) -> str:
    r = requests.post(f"{API}/auth/login", json={"username": username, "password": password}, timeout=15)
    assert r.status_code == 200, f"login {username} failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_token():
    return _login("admin", "Admin@2026")


@pytest.fixture(scope="module")
def emp_token():
    # emp7 used because credentials note said it's OK to test password changes on emp7
    return _login("emp7", "Emp@2026")


def _h(tok: str):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


# --- Regression: existing endpoints ---
class TestRegression:
    def test_login_admin(self, admin_token):
        assert admin_token

    def test_login_employee(self, emp_token):
        assert emp_token

    def test_list_users_admin(self, admin_token):
        r = requests.get(f"{API}/admin/users", headers=_h(admin_token))
        assert r.status_code == 200
        users = r.json()
        assert any(u["username"] == "admin" for u in users)
        assert sum(1 for u in users if u["role"] == "employee") >= 7

    def test_list_users_forbidden_for_employee(self, emp_token):
        r = requests.get(f"{API}/admin/users", headers=_h(emp_token))
        assert r.status_code == 403

    def test_list_customers(self, emp_token):
        r = requests.get(f"{API}/customers", headers=_h(emp_token))
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_list_sales(self, emp_token):
        r = requests.get(f"{API}/sales?scope=mine", headers=_h(emp_token))
        assert r.status_code == 200
        assert isinstance(r.json(), list)


# --- PATCH /api/admin/users/{username} ---
class TestAdminPatchUser:
    def test_non_admin_forbidden(self, emp_token):
        r = requests.patch(
            f"{API}/admin/users/emp7",
            headers=_h(emp_token),
            json={"display_name": "Hacker"},
        )
        assert r.status_code == 403

    def test_unknown_user_404(self, admin_token):
        r = requests.patch(
            f"{API}/admin/users/does_not_exist_xyz",
            headers=_h(admin_token),
            json={"display_name": "X"},
        )
        assert r.status_code == 404

    def test_empty_patch_400(self, admin_token):
        r = requests.patch(f"{API}/admin/users/emp7", headers=_h(admin_token), json={})
        assert r.status_code == 400

    def test_short_password_400(self, admin_token):
        r = requests.patch(
            f"{API}/admin/users/emp7",
            headers=_h(admin_token),
            json={"password": "abc"},
        )
        assert r.status_code == 400

    def test_empty_display_name_400(self, admin_token):
        r = requests.patch(
            f"{API}/admin/users/emp7",
            headers=_h(admin_token),
            json={"display_name": "   "},
        )
        assert r.status_code == 400

    def test_display_name_persists(self, admin_token):
        new_name = f"Emp7 Test {uuid.uuid4().hex[:4]}"
        r = requests.patch(
            f"{API}/admin/users/emp7",
            headers=_h(admin_token),
            json={"display_name": new_name},
        )
        assert r.status_code == 200, r.text
        assert r.json()["display_name"] == new_name

        # Verify persistence via list
        r2 = requests.get(f"{API}/admin/users", headers=_h(admin_token))
        row = next(u for u in r2.json() if u["username"] == "emp7")
        assert row["display_name"] == new_name

        # Restore
        requests.patch(
            f"{API}/admin/users/emp7",
            headers=_h(admin_token),
            json={"display_name": "Employee 7"},
        )

    def test_password_update_changes_login(self, admin_token):
        new_pw = "NewPass@2026"
        r = requests.patch(
            f"{API}/admin/users/emp7",
            headers=_h(admin_token),
            json={"password": new_pw},
        )
        assert r.status_code == 200, r.text

        # Old password should now fail
        r_old = requests.post(f"{API}/auth/login", json={"username": "emp7", "password": "Emp@2026"})
        assert r_old.status_code == 401

        # New password should succeed
        r_new = requests.post(f"{API}/auth/login", json={"username": "emp7", "password": new_pw})
        assert r_new.status_code == 200

        # Restore original password so test_credentials.md stays accurate
        restore = requests.patch(
            f"{API}/admin/users/emp7",
            headers=_h(admin_token),
            json={"password": "Emp@2026"},
        )
        assert restore.status_code == 200
        # verify restored
        r_check = requests.post(f"{API}/auth/login", json={"username": "emp7", "password": "Emp@2026"})
        assert r_check.status_code == 200


# --- POST /api/customers (employee creates for punch-sale-new-customer flow) ---
class TestEmployeeCreateCustomer:
    _created_ids = []
    _created_phones = []

    @classmethod
    def teardown_class(cls):
        # cleanup — delete created test customers
        try:
            admin = _login("admin", "Admin@2026")
            for cid in cls._created_ids:
                requests.delete(f"{API}/customers/{cid}", headers=_h(admin))
        except Exception:
            pass

    def test_employee_creates_customer_assigned_to_self(self, emp_token):
        phone = "9" + str(uuid.uuid4().int)[:9]
        name = f"TEST_PunchSale {uuid.uuid4().hex[:6]}"
        r = requests.post(
            f"{API}/customers",
            headers=_h(emp_token),
            json={"name": name, "phone": phone},
        )
        assert r.status_code == 200, r.text
        c = r.json()
        assert c["name"] == name
        assert c["phone"] == phone
        assert c["assigned_to"] == "emp7"
        assert c["status"] == "pending"
        TestEmployeeCreateCustomer._created_ids.append(c["id"])
        TestEmployeeCreateCustomer._created_phones.append(phone)

        # Verify it appears in employee's own customer list
        r2 = requests.get(f"{API}/customers?scope=mine", headers=_h(emp_token))
        assert r2.status_code == 200
        assert any(x["id"] == c["id"] for x in r2.json())

    def test_duplicate_phone_returns_409(self, emp_token):
        assert TestEmployeeCreateCustomer._created_phones, "prev test must have run"
        phone = TestEmployeeCreateCustomer._created_phones[0]
        r = requests.post(
            f"{API}/customers",
            headers=_h(emp_token),
            json={"name": "TEST_Dup", "phone": phone},
        )
        assert r.status_code == 409

    def test_employee_cannot_override_assignee(self, emp_token):
        """Even if employee sends assigned_to=someone_else, backend must force self."""
        phone = "8" + str(uuid.uuid4().int)[:9]
        r = requests.post(
            f"{API}/customers",
            headers=_h(emp_token),
            json={"name": "TEST_AssignSelf", "phone": phone, "assigned_to": "emp1"},
        )
        assert r.status_code == 200, r.text
        c = r.json()
        assert c["assigned_to"] == "emp7"
        TestEmployeeCreateCustomer._created_ids.append(c["id"])

    def test_create_and_then_sale(self, emp_token):
        """End-to-end simulating punch-sale-new-customer path."""
        phone = "7" + str(uuid.uuid4().int)[:9]
        rc = requests.post(
            f"{API}/customers",
            headers=_h(emp_token),
            json={"name": "TEST_SaleFlow", "phone": phone},
        )
        assert rc.status_code == 200, rc.text
        cust = rc.json()
        TestEmployeeCreateCustomer._created_ids.append(cust["id"])

        rs = requests.post(
            f"{API}/sales",
            headers=_h(emp_token),
            json={
                "customer_id": cust["id"],
                "customer_name": cust["name"],
                "amount": 1234.5,
                "product": "TEST",
            },
        )
        assert rs.status_code == 200, rs.text
        sale = rs.json()
        assert sale["customer_id"] == cust["id"]
        assert sale["customer_name"] == cust["name"]
        assert sale["amount"] == 1234.5
        assert sale["user"] == "emp7"
