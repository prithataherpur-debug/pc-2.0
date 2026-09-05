"""
Iteration 8 tests — Sales owner-edit + admin drill-down/reassign/delete for Calls & Sales.
Covers:
 - PATCH /api/sales/{sid} owner can update amount/product/notes, cannot set purchase_amount (403)
 - PATCH /api/sales/{sid} non-owner non-admin → 403
 - PATCH /api/sales/{sid} admin can update everything + profit recalc
 - PATCH /api/sales/{sid} unknown sid → 404
 - DELETE /api/sales/{sid} admin=200, employee=403
 - GET /api/admin/users/{u}/calls admin-only, sorted, limit, 404
 - GET /api/admin/users/{u}/sales admin-only, sorted, 404
 - POST /api/admin/calls/reassign admin-only, moves user, empty ids 400, non-employee 400
 - POST /api/admin/sales/reassign admin-only, moves user + display_name cache
 - DELETE /api/admin/calls/{cid} admin-only, 404 on unknown
"""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/") + "/api"

ADMIN = ("admin", "Admin@2026")
EMP1 = ("emp1", "Emp@2026")
EMP2 = ("emp2", "Emp@2026")


def _login(username, password):
    r = requests.post(f"{BASE_URL}/auth/login", json={"username": username, "password": password}, timeout=15)
    assert r.status_code == 200, f"login failed for {username}: {r.status_code} {r.text}"
    return r.json()["access_token"]


def _h(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def tokens():
    return {
        "admin": _login(*ADMIN),
        "emp1": _login(*EMP1),
        "emp2": _login(*EMP2),
    }


# ---------- helpers ----------
def _create_sale_as(tok, amount=100.0, product="TEST_prod", notes="TEST_note"):
    r = requests.post(
        f"{BASE_URL}/sales",
        headers=_h(tok),
        json={"customer_name": "TEST_iter8_cust", "amount": amount, "product": product, "notes": notes},
        timeout=15,
    )
    assert r.status_code == 200, f"create_sale: {r.status_code} {r.text}"
    return r.json()


def _create_call_as_emp(tok_emp):
    """Create a call_log by transitioning a customer status. Returns the created call log id."""
    # List my customers, pick first pending
    r = requests.get(f"{BASE_URL}/customers", headers=_h(tok_emp), timeout=15)
    assert r.status_code == 200
    custs = r.json()
    if not custs:
        pytest.skip("employee has no customers")
    cid = custs[0]["id"]
    # transition to no_answer (safe, no side effects like WA)
    r2 = requests.patch(
        f"{BASE_URL}/customers/{cid}/status",
        headers=_h(tok_emp),
        json={"status": "no_answer"},
        timeout=15,
    )
    assert r2.status_code == 200, f"status update: {r2.status_code} {r2.text}"
    return cid


# ---------- Sales PATCH ----------
class TestSalesPatch:
    def test_owner_updates_amount_product_notes(self, tokens):
        sale = _create_sale_as(tokens["emp1"], amount=250.0)
        sid = sale["id"]
        r = requests.patch(
            f"{BASE_URL}/sales/{sid}",
            headers=_h(tokens["emp1"]),
            json={"amount": 275.5, "product": "TEST_upd_p", "notes": "TEST_upd_n"},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["amount"] == 275.5
        assert body["product"] == "TEST_upd_p"
        assert body["notes"] == "TEST_upd_n"
        # cleanup
        requests.delete(f"{BASE_URL}/sales/{sid}", headers=_h(tokens["admin"]))

    def test_owner_cannot_set_purchase_amount(self, tokens):
        sale = _create_sale_as(tokens["emp1"], amount=300.0)
        sid = sale["id"]
        r = requests.patch(
            f"{BASE_URL}/sales/{sid}",
            headers=_h(tokens["emp1"]),
            json={"purchase_amount": 100.0},
            timeout=15,
        )
        assert r.status_code == 403, f"expected 403 got {r.status_code} {r.text}"
        requests.delete(f"{BASE_URL}/sales/{sid}", headers=_h(tokens["admin"]))

    def test_non_owner_non_admin_forbidden(self, tokens):
        sale = _create_sale_as(tokens["emp1"], amount=400.0)
        sid = sale["id"]
        r = requests.patch(
            f"{BASE_URL}/sales/{sid}",
            headers=_h(tokens["emp2"]),
            json={"amount": 500.0},
            timeout=15,
        )
        assert r.status_code == 403, r.text
        requests.delete(f"{BASE_URL}/sales/{sid}", headers=_h(tokens["admin"]))

    def test_admin_updates_everything_and_profit_recalcs(self, tokens):
        sale = _create_sale_as(tokens["emp1"], amount=1000.0)
        sid = sale["id"]
        r = requests.patch(
            f"{BASE_URL}/sales/{sid}",
            headers=_h(tokens["admin"]),
            json={"amount": 1200.0, "purchase_amount": 800.0, "product": "TEST_admin_p", "notes": "TEST_admin_n"},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["amount"] == 1200.0
        assert body["purchase_amount"] == 800.0
        assert body["profit"] == 400.0
        assert body["product"] == "TEST_admin_p"
        # GET-verify by listing admin sales for owner
        r2 = requests.get(f"{BASE_URL}/admin/users/emp1/sales", headers=_h(tokens["admin"]), timeout=15)
        assert r2.status_code == 200
        found = [s for s in r2.json() if s["id"] == sid]
        assert found and found[0]["purchase_amount"] == 800.0 and found[0]["profit"] == 400.0
        requests.delete(f"{BASE_URL}/sales/{sid}", headers=_h(tokens["admin"]))

    def test_unknown_sid_returns_404(self, tokens):
        r = requests.patch(
            f"{BASE_URL}/sales/{uuid.uuid4()}",
            headers=_h(tokens["admin"]),
            json={"amount": 10.0},
            timeout=15,
        )
        assert r.status_code == 404


# ---------- Sales DELETE ----------
class TestSalesDelete:
    def test_admin_can_delete_any(self, tokens):
        sale = _create_sale_as(tokens["emp1"], amount=50.0)
        sid = sale["id"]
        r = requests.delete(f"{BASE_URL}/sales/{sid}", headers=_h(tokens["admin"]), timeout=15)
        assert r.status_code == 200
        # verify gone
        r2 = requests.patch(f"{BASE_URL}/sales/{sid}", headers=_h(tokens["admin"]), json={"amount": 1.0})
        assert r2.status_code == 404

    def test_employee_cannot_delete_own(self, tokens):
        sale = _create_sale_as(tokens["emp1"], amount=60.0)
        sid = sale["id"]
        r = requests.delete(f"{BASE_URL}/sales/{sid}", headers=_h(tokens["emp1"]), timeout=15)
        assert r.status_code == 403, r.text
        # cleanup
        requests.delete(f"{BASE_URL}/sales/{sid}", headers=_h(tokens["admin"]))


# ---------- Admin drill-down GET ----------
class TestAdminUserCalls:
    def test_admin_only(self, tokens):
        r = requests.get(f"{BASE_URL}/admin/users/emp1/calls", headers=_h(tokens["emp1"]), timeout=15)
        assert r.status_code == 403

    def test_returns_sorted_newest_first_and_limit(self, tokens):
        # create 2 calls quickly for emp1
        _create_call_as_emp(tokens["emp1"])
        time.sleep(0.05)
        _create_call_as_emp(tokens["emp1"])
        r = requests.get(f"{BASE_URL}/admin/users/emp1/calls?limit=5", headers=_h(tokens["admin"]), timeout=15)
        assert r.status_code == 200
        logs = r.json()
        assert isinstance(logs, list)
        assert len(logs) <= 5
        if len(logs) >= 2:
            assert logs[0]["timestamp"] >= logs[1]["timestamp"], "not newest first"

    def test_unknown_username_404(self, tokens):
        r = requests.get(f"{BASE_URL}/admin/users/no_such_user_xyz/calls", headers=_h(tokens["admin"]), timeout=15)
        assert r.status_code == 404


class TestAdminUserSales:
    def test_admin_only(self, tokens):
        r = requests.get(f"{BASE_URL}/admin/users/emp1/sales", headers=_h(tokens["emp1"]), timeout=15)
        assert r.status_code == 403

    def test_returns_sale_shape(self, tokens):
        s = _create_sale_as(tokens["emp1"], amount=77.0)
        r = requests.get(f"{BASE_URL}/admin/users/emp1/sales", headers=_h(tokens["admin"]), timeout=15)
        assert r.status_code == 200
        arr = r.json()
        assert isinstance(arr, list) and len(arr) >= 1
        first = arr[0]
        for k in ("id", "user", "amount", "currency", "date_key", "timestamp"):
            assert k in first
        # cleanup
        requests.delete(f"{BASE_URL}/sales/{s['id']}", headers=_h(tokens["admin"]))

    def test_unknown_username_404(self, tokens):
        r = requests.get(f"{BASE_URL}/admin/users/nonesuch_zz/sales", headers=_h(tokens["admin"]), timeout=15)
        assert r.status_code == 404


# ---------- Reassign endpoints ----------
class TestCallsReassign:
    def test_admin_only(self, tokens):
        r = requests.post(
            f"{BASE_URL}/admin/calls/reassign",
            headers=_h(tokens["emp1"]),
            json={"ids": ["x"], "new_owner": "emp2"},
            timeout=15,
        )
        assert r.status_code == 403

    def test_empty_ids_400(self, tokens):
        r = requests.post(
            f"{BASE_URL}/admin/calls/reassign",
            headers=_h(tokens["admin"]),
            json={"ids": [], "new_owner": "emp2"},
            timeout=15,
        )
        assert r.status_code == 400

    def test_target_must_be_employee(self, tokens):
        r = requests.post(
            f"{BASE_URL}/admin/calls/reassign",
            headers=_h(tokens["admin"]),
            json={"ids": ["fake"], "new_owner": "admin"},
            timeout=15,
        )
        assert r.status_code == 400

    def test_moves_call_across_users(self, tokens):
        _create_call_as_emp(tokens["emp1"])
        # find latest call for emp1
        r = requests.get(f"{BASE_URL}/admin/users/emp1/calls?limit=1", headers=_h(tokens["admin"]))
        assert r.status_code == 200 and r.json(), "no call log to move"
        call_id = r.json()[0]["id"]
        # move to emp2
        r2 = requests.post(
            f"{BASE_URL}/admin/calls/reassign",
            headers=_h(tokens["admin"]),
            json={"ids": [call_id], "new_owner": "emp2"},
            timeout=15,
        )
        assert r2.status_code == 200, r2.text
        assert r2.json()["updated"] == 1
        # verify — appears under emp2 now
        r3 = requests.get(f"{BASE_URL}/admin/users/emp2/calls?limit=50", headers=_h(tokens["admin"]))
        assert any(c["id"] == call_id for c in r3.json())
        # cleanup — delete via admin endpoint
        requests.delete(f"{BASE_URL}/admin/calls/{call_id}", headers=_h(tokens["admin"]))


class TestSalesReassign:
    def test_admin_only(self, tokens):
        r = requests.post(
            f"{BASE_URL}/admin/sales/reassign",
            headers=_h(tokens["emp1"]),
            json={"ids": ["x"], "new_owner": "emp2"},
            timeout=15,
        )
        assert r.status_code == 403

    def test_empty_ids_400(self, tokens):
        r = requests.post(
            f"{BASE_URL}/admin/sales/reassign",
            headers=_h(tokens["admin"]),
            json={"ids": [], "new_owner": "emp2"},
            timeout=15,
        )
        assert r.status_code == 400

    def test_moves_sale_and_updates_display_name(self, tokens):
        s = _create_sale_as(tokens["emp1"], amount=222.0)
        sid = s["id"]
        # Get emp2 display_name for verification
        r_users = requests.get(f"{BASE_URL}/admin/users", headers=_h(tokens["admin"]))
        emp2_dn = next((u["display_name"] for u in r_users.json() if u["username"] == "emp2"), "emp2")
        r = requests.post(
            f"{BASE_URL}/admin/sales/reassign",
            headers=_h(tokens["admin"]),
            json={"ids": [sid], "new_owner": "emp2"},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        assert r.json()["updated"] == 1
        # verify under emp2 and display_name cache is set
        r2 = requests.get(f"{BASE_URL}/admin/users/emp2/sales", headers=_h(tokens["admin"]))
        moved = [x for x in r2.json() if x["id"] == sid]
        assert moved and moved[0]["user"] == "emp2"
        assert moved[0]["display_name"] == emp2_dn
        # cleanup
        requests.delete(f"{BASE_URL}/sales/{sid}", headers=_h(tokens["admin"]))


class TestAdminDeleteCall:
    def test_admin_only(self, tokens):
        r = requests.delete(f"{BASE_URL}/admin/calls/anything", headers=_h(tokens["emp1"]), timeout=15)
        assert r.status_code == 403

    def test_unknown_id_404(self, tokens):
        r = requests.delete(f"{BASE_URL}/admin/calls/{uuid.uuid4()}", headers=_h(tokens["admin"]), timeout=15)
        assert r.status_code == 404

    def test_delete_ok(self, tokens):
        _create_call_as_emp(tokens["emp1"])
        r = requests.get(f"{BASE_URL}/admin/users/emp1/calls?limit=1", headers=_h(tokens["admin"]))
        assert r.status_code == 200 and r.json()
        cid = r.json()[0]["id"]
        r2 = requests.delete(f"{BASE_URL}/admin/calls/{cid}", headers=_h(tokens["admin"]), timeout=15)
        assert r2.status_code == 200
        # verify gone
        r3 = requests.get(f"{BASE_URL}/admin/users/emp1/calls?limit=200", headers=_h(tokens["admin"]))
        assert not any(c["id"] == cid for c in r3.json())
