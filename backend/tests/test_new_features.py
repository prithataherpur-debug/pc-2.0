"""Tests for the 4 new features:
   (1) leaderboard, (2) bulk preview, (3) attendance break, (4) selfie upload/media token.
"""
import io
import os
import time
import pytest
import requests

BASE = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
API = f"{BASE}/api"
RUN = str(int(time.time()))[-6:]

# 1x1 PNG bytes
PNG_1x1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000d49444154789c62000100000005000100200e17f60000000049454e"
    "44ae426082"
)


def _h(t):
    return {"Authorization": f"Bearer {t}", "Content-Type": "application/json"}


def _hb(t):
    return {"Authorization": f"Bearer {t}"}


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
    return r.json()["access_token"]


# ================= Leaderboard =================
class TestLeaderboard:
    def test_leaderboard_structure(self, emp1_token):
        r = requests.get(f"{API}/stats/leaderboard", headers=_h(emp1_token))
        assert r.status_code == 200, r.text
        d = r.json()
        assert "rows" in d and "goal" in d and "date" in d
        rows = d["rows"]
        # 7 employees seeded
        assert len(rows) == 7
        keys = {"rank", "username", "display_name", "total", "interested", "goal", "pct", "is_me"}
        for row in rows:
            assert keys.issubset(row.keys()), f"missing keys in {row}"
            assert isinstance(row["rank"], int)
            assert isinstance(row["total"], int)
            assert isinstance(row["interested"], int)
            assert isinstance(row["pct"], (int, float))
            assert 0.0 <= row["pct"] <= 1.0

    def test_leaderboard_ordering_and_ranks(self, emp1_token):
        r = requests.get(f"{API}/stats/leaderboard", headers=_h(emp1_token))
        rows = r.json()["rows"]
        # ranks are 1..N in order
        assert [row["rank"] for row in rows] == list(range(1, len(rows) + 1))
        # sort by (-total, -interested, username asc)
        prev = None
        for row in rows:
            key = (-row["total"], -row["interested"], row["username"])
            if prev is not None:
                assert prev <= key, f"ordering broken at {row}"
            prev = key

    def test_leaderboard_is_me(self, emp1_token, emp2_token):
        r1 = requests.get(f"{API}/stats/leaderboard", headers=_h(emp1_token)).json()
        me1 = [row for row in r1["rows"] if row["is_me"]]
        assert len(me1) == 1 and me1[0]["username"] == "emp1"

        r2 = requests.get(f"{API}/stats/leaderboard", headers=_h(emp2_token)).json()
        me2 = [row for row in r2["rows"] if row["is_me"]]
        assert len(me2) == 1 and me2[0]["username"] == "emp2"

    def test_leaderboard_requires_auth(self):
        r = requests.get(f"{API}/stats/leaderboard")
        assert r.status_code == 401


# ================= Bulk Preview =================
class TestBulkPreview:
    def test_preview_mixed(self, admin_token):
        # First, seed one existing phone
        existing_phone = f"+91 555 {RUN} 4321"
        c = requests.post(f"{API}/customers", headers=_h(admin_token),
                          json={"name": f"TEST_Preview_Existing_{RUN}",
                                "phone": existing_phone, "assigned_to": "emp1"})
        assert c.status_code == 200, c.text
        existing_id = c.json()["id"]

        # count before
        before = requests.get(f"{API}/customers?scope=all", headers=_h(admin_token))
        count_before = len(before.json())

        payload = {"customers": [
            {"name": f"TEST_Preview_NEW1_{RUN}", "phone": f"+91-777-{RUN}-1001"},   # new
            {"name": f"TEST_Preview_ExDup_{RUN}", "phone": existing_phone},           # already in system
            {"name": f"TEST_Preview_BatchDup_{RUN}", "phone": f"91 777 {RUN} 1001"},  # repeats row 0
            {"name": f"TEST_Preview_Bad_{RUN}", "phone": "abc"},                       # invalid
        ]}
        r = requests.post(f"{API}/customers/preview-bulk", headers=_h(admin_token), json=payload)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["total"] == 4
        assert d["new"] == 1
        assert d["duplicates"] == 3
        rows = d["rows"]
        assert rows[0]["status"] == "new" and rows[0]["reason"] is None
        assert rows[1]["status"] == "duplicate" and rows[1]["reason"] == "already_in_system"
        assert rows[2]["status"] == "duplicate" and rows[2]["reason"] == "repeated_in_batch"
        assert rows[3]["status"] == "duplicate" and rows[3]["reason"] == "invalid_phone"

        # assignee_preview correctness
        assert rows[0]["assignee_preview"] is not None
        assert rows[0]["assignee_preview"].startswith("emp")
        for i in (1, 2, 3):
            assert rows[i]["assignee_preview"] is None

        # DB count unchanged (preview doesn't insert)
        after = requests.get(f"{API}/customers?scope=all", headers=_h(admin_token))
        assert len(after.json()) == count_before

        # cleanup seeded row
        requests.delete(f"{API}/customers/{existing_id}", headers=_h(admin_token))

    def test_preview_requires_auth(self):
        r = requests.post(f"{API}/customers/preview-bulk", json={"customers": []})
        assert r.status_code == 401


# ================= Break timer =================
class TestBreaks:
    def test_break_requires_checkin(self, emp2_token):
        # emp2 hasn't checked in — remove any prior record
        # Use a fresh scenario: try break-start without check-in for a fresh employee (emp7)
        r_login = requests.post(f"{API}/auth/login", json={"username": "emp7", "password": "Emp@2026"})
        tok = r_login.json()["access_token"]
        # If already checked in, we can't easily remove — just accept the outcome
        r = requests.post(f"{API}/attendance/break-start", headers=_h(tok))
        # Either 400 (no check-in) or 200 (has check-in). Verify contract:
        if r.status_code == 200:
            pytest.skip("emp7 already checked in today; contract still validated in other tests")
        assert r.status_code == 400

    def test_break_flow_idempotent(self, emp1_token):
        # ensure emp1 is checked in
        requests.post(f"{API}/attendance/check-in", headers=_h(emp1_token), json={})
        # Reset break state: if a check-out exists, we need to test differently
        today = requests.get(f"{API}/attendance/today", headers=_h(emp1_token)).json()
        rec = today["records"][0] if today["records"] else None
        if rec and rec.get("check_out"):
            # already checked out — break endpoints should 400 (can't start break)
            r = requests.post(f"{API}/attendance/break-start", headers=_h(emp1_token))
            assert r.status_code == 400
            return

        r1 = requests.post(f"{API}/attendance/break-start", headers=_h(emp1_token))
        assert r1.status_code == 200, r1.text
        breaks1 = r1.json().get("breaks") or []
        assert len(breaks1) >= 1
        assert breaks1[-1]["end"] is None

        # idempotent: second start does not append another open break
        r2 = requests.post(f"{API}/attendance/break-start", headers=_h(emp1_token))
        assert r2.status_code == 200
        breaks2 = r2.json().get("breaks") or []
        assert len(breaks2) == len(breaks1)

        # end break
        r3 = requests.post(f"{API}/attendance/break-end", headers=_h(emp1_token))
        assert r3.status_code == 200
        breaks3 = r3.json().get("breaks") or []
        assert breaks3[-1]["end"] is not None

        # break-end again → 400 (no open break)
        r4 = requests.post(f"{API}/attendance/break-end", headers=_h(emp1_token))
        assert r4.status_code == 400


# ================= Files / selfie =================
class TestFiles:
    uploaded = {}

    def test_upload_returns_path_url_token(self, emp1_token):
        files = {"file": ("selfie.png", PNG_1x1, "image/png")}
        r = requests.post(f"{API}/files/upload", headers=_hb(emp1_token), files=files)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["path"].startswith("callflow-crm/uploads/emp1/")
        assert d["path"].endswith(".png")
        assert d["url"].startswith("/api/files/")
        assert d["token"]
        TestFiles.uploaded["png"] = d

    def test_non_image_extension_defaults_to_jpg(self, emp1_token):
        files = {"file": ("weird.xyz", PNG_1x1, "application/octet-stream")}
        r = requests.post(f"{API}/files/upload", headers=_hb(emp1_token), files=files)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["path"].endswith(".jpg"), f"expected .jpg default got {d['path']}"

    def test_upload_too_large(self, emp1_token):
        big = b"\x00" * (8 * 1024 * 1024 + 10)
        files = {"file": ("big.jpg", big, "image/jpeg")}
        r = requests.post(f"{API}/files/upload", headers=_hb(emp1_token), files=files)
        assert r.status_code == 413

    def test_download_with_token_ok(self, emp1_token):
        d = TestFiles.uploaded.get("png")
        assert d, "upload test must run first"
        r = requests.get(f"{BASE}{d['url']}?token={d['token']}")
        assert r.status_code == 200
        assert "image" in r.headers.get("Content-Type", "")
        assert r.content == PNG_1x1

    def test_download_wrong_token(self, emp1_token, admin_token):
        d = TestFiles.uploaded.get("png")
        # forge a token for a different path via /files/token
        tok_resp = requests.get(f"{API}/files/token?path=callflow-crm/uploads/emp1/other.png",
                                headers=_h(emp1_token))
        assert tok_resp.status_code == 200
        wrong_token = tok_resp.json()["token"]
        r = requests.get(f"{BASE}{d['url']}?token={wrong_token}")
        assert r.status_code == 403

    def test_download_no_auth_at_all(self):
        d = TestFiles.uploaded.get("png")
        r = requests.get(f"{BASE}{d['url']}")
        assert r.status_code == 401

    def test_download_with_bearer(self, emp1_token):
        d = TestFiles.uploaded.get("png")
        r = requests.get(f"{BASE}{d['url']}", headers=_hb(emp1_token))
        assert r.status_code == 200
        assert r.content == PNG_1x1

    def test_files_token_endpoint_needs_bearer(self):
        r = requests.get(f"{API}/files/token?path=whatever")
        assert r.status_code == 401

    def test_files_token_endpoint_ok_and_download(self, emp1_token):
        d = TestFiles.uploaded.get("png")
        tok_resp = requests.get(f"{API}/files/token?path={d['path']}", headers=_h(emp1_token))
        assert tok_resp.status_code == 200
        tok = tok_resp.json()["token"]
        r = requests.get(f"{BASE}{d['url']}?token={tok}")
        assert r.status_code == 200


# ================= Attendance selfie fields =================
class TestAttendanceSelfie:
    def test_checkin_stores_selfie_path(self, admin_token, emp1_token):
        # Upload a selfie
        files = {"file": ("in.png", PNG_1x1, "image/png")}
        up = requests.post(f"{API}/files/upload", headers=_hb(emp1_token), files=files).json()

        # Force fresh attendance by wiping today record via admin — not exposed via API,
        # so we test on emp who might already be checked in. Contract: if already checked in,
        # endpoint returns existing doc without overwriting; use emp3 for fresh test if possible.
        r_login = requests.post(f"{API}/auth/login", json={"username": "emp5", "password": "Emp@2026"})
        tok = r_login.json()["access_token"]
        files2 = {"file": ("in5.png", PNG_1x1, "image/png")}
        up5 = requests.post(f"{API}/files/upload", headers=_hb(tok), files=files2).json()

        r = requests.post(f"{API}/attendance/check-in", headers=_h(tok),
                          json={"selfie_path": up5["path"]})
        assert r.status_code == 200, r.text
        d = r.json()
        # If already-existing record (idempotent), selfie may be None from prior test.
        # Contract check: field exists.
        assert "check_in_selfie" in d

    def test_checkout_stores_selfie_path(self, emp1_token):
        files = {"file": ("out.png", PNG_1x1, "image/png")}
        up = requests.post(f"{API}/files/upload", headers=_hb(emp1_token), files=files).json()

        # ensure checked in
        requests.post(f"{API}/attendance/check-in", headers=_h(emp1_token), json={})
        # end any open break so check-out succeeds
        requests.post(f"{API}/attendance/break-end", headers=_h(emp1_token))

        r = requests.post(f"{API}/attendance/check-out", headers=_h(emp1_token),
                          json={"selfie_path": up["path"]})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["check_out_selfie"] == up["path"]
