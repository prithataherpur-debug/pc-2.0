from fastapi import FastAPI, APIRouter, HTTPException, Depends, UploadFile, File, Query
from fastapi.responses import Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.concurrency import run_in_threadpool
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from contextlib import asynccontextmanager
import os
import json
import re
import logging
import httpx
import bcrypt
import jwt
import uuid
import requests
import io
from openpyxl import Workbook
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Annotated
from datetime import datetime, timezone, timedelta

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# ---------- Env ----------
MONGO_URL = os.environ['MONGO_URL']
DB_NAME = os.environ['DB_NAME']
JWT_SECRET = os.environ.get("JWT_SECRET", "dev_secret_change")
JWT_ALGO = "HS256"
JWT_MINUTES = int(os.environ.get("JWT_EXPIRE_MINUTES", "1440"))
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "Admin@2026")
DEFAULT_EMPLOYEE_PASSWORD = os.environ.get("DEFAULT_EMPLOYEE_PASSWORD", "Emp@2026")
META_TOKEN = os.environ.get("META_WA_ACCESS_TOKEN", "placeholder")
META_PHONE_ID = os.environ.get("META_WA_PHONE_NUMBER_ID", "placeholder")
META_API_VER = os.environ.get("META_WA_API_VERSION", "v22.0")

# Object storage
STORAGE_BASE = (os.environ.get("INTEGRATION_PROXY_URL") or "").strip() or "https://integrations.emergentagent.com"
STORAGE_URL = STORAGE_BASE.rstrip("/") + "/objstore/api/v1/storage"
EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")
APP_NAME = "callflow-crm"
storage_key: Optional[str] = None

PUSH_BASE_URL = "https://integrations.emergentagent.com"
PUSH_KEY = os.environ.get("EMERGENT_PUSH_KEY", "placeholder")

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]
_push_client = httpx.AsyncClient(
    base_url=PUSH_BASE_URL, headers={"X-Push-Key": PUSH_KEY}, timeout=10.0
)
_wa_client = httpx.AsyncClient(timeout=15.0)

logger = logging.getLogger("callflow")
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')

# ---------- Helpers ----------
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def today_key() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")

def norm_phone(p: str) -> str:
    return re.sub(r"\D", "", p or "")


# ---------- Object storage ----------
def _init_storage_sync() -> str:
    global storage_key
    if storage_key:
        return storage_key
    if not EMERGENT_LLM_KEY:
        raise RuntimeError("EMERGENT_LLM_KEY not set — object storage disabled")
    resp = requests.post(
        f"{STORAGE_URL}/init",
        json={"emergent_key": EMERGENT_LLM_KEY},
        timeout=30,
    )
    resp.raise_for_status()
    storage_key = resp.json()["storage_key"]
    return storage_key


def _put_object_sync(path: str, data: bytes, content_type: str) -> dict:
    key = _init_storage_sync()
    try:
        resp = requests.put(
            f"{STORAGE_URL}/objects/{path}",
            headers={"X-Storage-Key": key, "Content-Type": content_type},
            data=data,
            timeout=120,
        )
        if resp.status_code == 503:
            # stale key — reset and retry once
            globals()["storage_key"] = None
            key = _init_storage_sync()
            resp = requests.put(
                f"{STORAGE_URL}/objects/{path}",
                headers={"X-Storage-Key": key, "Content-Type": content_type},
                data=data,
                timeout=120,
            )
        resp.raise_for_status()
        return resp.json()
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else 500
        raise HTTPException(status, f"Storage upload failed: {status}")


def _get_object_sync(path: str) -> tuple[bytes, str]:
    key = _init_storage_sync()
    try:
        resp = requests.get(
            f"{STORAGE_URL}/objects/{path}",
            headers={"X-Storage-Key": key},
            timeout=60,
        )
        if resp.status_code == 503:
            globals()["storage_key"] = None
            key = _init_storage_sync()
            resp = requests.get(
                f"{STORAGE_URL}/objects/{path}",
                headers={"X-Storage-Key": key},
                timeout=60,
            )
        resp.raise_for_status()
        return resp.content, resp.headers.get("Content-Type", "application/octet-stream")
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else 500
        # Storage returns 500 for missing objects
        raise HTTPException(404 if status in (404, 500) else status, "File not found")


async def put_object(path: str, data: bytes, content_type: str) -> dict:
    return await run_in_threadpool(_put_object_sync, path, data, content_type)


async def get_object(path: str) -> tuple[bytes, str]:
    return await run_in_threadpool(_get_object_sync, path)


def hash_pw(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=10)).decode()

def verify_pw(pw: str, stored: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), stored.encode())
    except Exception:
        return False

# ---------- Models ----------
class LoginBody(BaseModel):
    username: str
    password: str

class UserOut(BaseModel):
    id: str
    username: str
    role: str
    display_name: Optional[str] = None
    daily_goal: Optional[int] = None

class Customer(BaseModel):
    id: str
    name: str
    phone: str
    address: Optional[str] = ""
    notes: Optional[str] = ""
    status: str = "pending"
    assigned_to: Optional[str] = None
    last_called_at: Optional[str] = None
    followup_date: Optional[str] = None
    rating: Optional[int] = None
    feedback: Optional[str] = ""
    whatsapp_sent_at: Optional[str] = None
    created_at: str

class CustomerCreate(BaseModel):
    name: str
    phone: str
    address: Optional[str] = ""
    notes: Optional[str] = ""
    assigned_to: Optional[str] = None

class BulkCreate(BaseModel):
    customers: List[CustomerCreate]

class StatusUpdate(BaseModel):
    status: str

class FeedbackBody(BaseModel):
    rating: int = Field(ge=1, le=5)
    notes: Optional[str] = ""

class ReassignBody(BaseModel):
    customer_ids: List[str]
    new_owner: str


class AdminUserUpdate(BaseModel):
    display_name: Optional[str] = None
    password: Optional[str] = None
    daily_goal: Optional[int] = None
    reset_daily_goal: Optional[bool] = None
    new_username: Optional[str] = None


class AdminUserCreate(BaseModel):
    username: str
    password: str
    display_name: Optional[str] = None
    daily_goal: Optional[int] = None


class ReassignItemsBody(BaseModel):
    ids: List[str]
    new_owner: str


class SaleBody(BaseModel):
    customer_id: Optional[str] = None
    customer_name: Optional[str] = ""
    amount: float = Field(ge=0)
    cash_amount: Optional[float] = None
    online_amount: Optional[float] = None
    payment_mode: Optional[str] = None  # cash | online | mixed (auto-derived if omitted)
    currency: str = "INR"
    product: Optional[str] = ""
    notes: Optional[str] = ""


class SalePatchBody(BaseModel):
    amount: Optional[float] = None
    purchase_amount: Optional[float] = None
    cash_amount: Optional[float] = None
    online_amount: Optional[float] = None
    payment_mode: Optional[str] = None
    product: Optional[str] = None
    notes: Optional[str] = None
    customer_name: Optional[str] = None
    customer_id: Optional[str] = None
    date_key: Optional[str] = None  # admin only


class Sale(BaseModel):
    id: str
    user: str
    display_name: Optional[str] = None
    customer_id: Optional[str] = None
    customer_name: Optional[str] = ""
    amount: float
    cash_amount: float = 0.0
    online_amount: float = 0.0
    payment_mode: str = "cash"  # cash | online | mixed
    purchase_amount: Optional[float] = None
    profit: float = 0.0
    currency: str
    product: Optional[str] = ""
    notes: Optional[str] = ""
    date_key: str
    timestamp: str
    source: str = "manual"  # "manual" | "invoice"
    invoice_id: Optional[str] = None
    invoice_no: Optional[str] = None
    linked_receipts: List[dict] = Field(default_factory=list)


# ---------- Invoice models ----------
class InvoiceItemBody(BaseModel):
    name: str
    qty: float = 1
    unit_price: float = 0


class InvoiceCreateBody(BaseModel):
    customer_name: str
    customer_mobile: str
    customer_address: Optional[str] = ""
    items: List[InvoiceItemBody]
    notes: Optional[str] = ""
    customer_id: Optional[str] = None
    attach_receipt_ids: List[str] = Field(default_factory=list)  # advance receipts to link to this invoice
    cash_amount: Optional[float] = None    # explicit cash portion (customer pays in cash)
    online_amount: Optional[float] = None  # explicit online portion


class InvoiceItem(BaseModel):
    name: str
    qty: float
    unit_price: float
    amount: float


class Invoice(BaseModel):
    id: str
    invoice_no: str
    user: str
    display_name: Optional[str] = None
    customer_id: Optional[str] = None
    customer_name: str
    customer_mobile: str
    customer_address: str = ""
    items: List[InvoiceItem]
    subtotal: float
    total: float
    cash_amount: float = 0.0
    online_amount: float = 0.0
    payment_mode: str = "cash"  # cash | online | mixed
    notes: str = ""
    sale_id: Optional[str] = None
    pdf_path: Optional[str] = None
    pdf_token: Optional[str] = None
    date_key: str
    created_at: str
    linked_receipts: List[dict] = Field(default_factory=list)


# ---------- Money Receipt models ----------
SOURCE_TYPES = {"sale", "invoice", "collection", "other"}


class ReceiptCreateBody(BaseModel):
    customer_id: Optional[str] = None
    customer_name: str
    customer_mobile: str = ""
    customer_address: Optional[str] = ""
    amount: float
    payment_mode: str = "cash"  # cash | online | mixed
    cash_amount: Optional[float] = None
    online_amount: Optional[float] = None
    source_type: str = "other"  # sale | invoice | collection | other
    source_id: Optional[str] = None
    reference_no: Optional[str] = None  # explicit override; auto-filled from source if omitted
    narration: Optional[str] = ""
    notes: Optional[str] = ""


class ReceiptPatchBody(BaseModel):
    reference_no: Optional[str] = None
    source_type: Optional[str] = None
    source_id: Optional[str] = None
    narration: Optional[str] = None
    notes: Optional[str] = None


class MoneyReceipt(BaseModel):
    id: str
    receipt_no: str
    user: str
    display_name: Optional[str] = None
    customer_id: Optional[str] = None
    customer_name: str
    customer_mobile: str = ""
    customer_address: str = ""
    amount: float
    payment_mode: str
    cash_amount: float = 0.0
    online_amount: float = 0.0
    source_type: str
    source_id: Optional[str] = None
    source_label: Optional[str] = None
    reference_no: str = ""  # sale bill / invoice # / collection ref; empty = advance
    narration: str = ""
    notes: str = ""
    pdf_path: Optional[str] = None
    pdf_token: Optional[str] = None
    date_key: str
    created_at: str


class ExpenseBody(BaseModel):
    amount: float = Field(ge=0)
    category: str
    description: Optional[str] = ""
    date_key: Optional[str] = None


class Expense(BaseModel):
    id: str
    amount: float
    category: str
    description: Optional[str] = ""
    date_key: str
    created_by: str
    created_at: str

class SettingsModel(BaseModel):
    daily_goal: int = 50
    whatsapp_template_name: str = "hello_world"
    whatsapp_language_code: str = "en_US"
    follow_up_days: int = 3
    collector_username: Optional[str] = None
    company_name: str = "Pritha Cabinet"
    company_address: str = ""
    company_gstin: str = ""
    company_phone: str = ""

class SettingsUpdate(BaseModel):
    daily_goal: Optional[int] = None
    whatsapp_template_name: Optional[str] = None
    whatsapp_language_code: Optional[str] = None
    follow_up_days: Optional[int] = None
    company_name: Optional[str] = None
    company_address: Optional[str] = None
    company_gstin: Optional[str] = None
    company_phone: Optional[str] = None


class CollectorAssignBody(BaseModel):
    username: Optional[str] = None  # None or "" clears assignment


DENOMS = [500, 200, 100, 50, 20, 10]


class CollectionEntryBody(BaseModel):
    date_key: Optional[str] = None
    cash_total: float = 0  # direct cash amount (no denomination breakdown)
    online_total: float = 0
    notes: Optional[str] = ""


class CollectionEntry(BaseModel):
    id: str
    user: str
    display_name: Optional[str] = None
    date_key: str
    denominations: dict = Field(default_factory=dict)  # kept for legacy records; new entries leave empty
    cash_total: float
    online_total: float
    grand_total: float
    notes: str = ""
    created_at: str
    updated_at: str
    linked_receipts: List[dict] = Field(default_factory=list)


class DailySaleBody(BaseModel):
    date_key: Optional[str] = None
    denominations: dict = Field(default_factory=dict)
    online_total: float = 0
    notes: Optional[str] = ""
    user: Optional[str] = None  # admin only: log/move the count on behalf of an employee


class DailySale(BaseModel):
    id: str
    user: str
    display_name: Optional[str] = None
    date_key: str
    denominations: dict
    cash_total: float
    online_total: float
    grand_total: float
    notes: str = ""
    created_at: str
    updated_at: str

class RegisterPushBody(BaseModel):
    user_id: str
    platform: str
    device_token: str

VALID_STATUS = {"pending", "interested", "not_interested", "callback", "no_answer", "done"}

# ---------- Auth ----------
bearer = HTTPBearer(auto_error=False)

def make_token(user: dict) -> str:
    payload = {
        "sub": user["username"],
        "role": user["role"],
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + timedelta(minutes=JWT_MINUTES),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)

async def current_user(cred: Annotated[Optional[HTTPAuthorizationCredentials], Depends(bearer)]):
    err = HTTPException(status_code=401, detail="Invalid or expired token")
    if not cred or cred.scheme.lower() != "bearer":
        raise err
    try:
        payload = jwt.decode(cred.credentials, JWT_SECRET, algorithms=[JWT_ALGO])
        username = payload.get("sub")
        if not username:
            raise err
    except jwt.PyJWTError:
        raise err
    user = await db.users.find_one({"username": username}, {"_id": 0})
    if not user:
        raise err
    return user

async def admin_only(user=Depends(current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return user


async def admin_or_collector(user=Depends(current_user)):
    """Daybook / cash desk features: admin or the currently assigned collector."""
    if user.get("role") == "admin":
        return user
    settings = await get_settings_doc()
    if settings.get("collector_username") == user.get("username"):
        return user
    raise HTTPException(status_code=403, detail="Only admin or the assigned collector can access this")


# ---------- Seed & lifespan ----------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # unique index on normalized phone (skips docs missing it)
    try:
        await db.customers.create_index("phone_norm", unique=True, sparse=True)
    except Exception as e:
        logger.warning(f"index error: {e}")

    await db.users.create_index("username", unique=True)

    # seed admin
    if not await db.users.find_one({"username": ADMIN_USERNAME}):
        await db.users.insert_one({
            "id": str(uuid.uuid4()),
            "username": ADMIN_USERNAME,
            "password_hash": hash_pw(ADMIN_PASSWORD),
            "role": "admin",
            "display_name": "Admin",
            "created_at": now_iso(),
        })

    # seed 7 employees
    for i in range(1, 8):
        u = f"emp{i}"
        if not await db.users.find_one({"username": u}):
            await db.users.insert_one({
                "id": str(uuid.uuid4()),
                "username": u,
                "password_hash": hash_pw(DEFAULT_EMPLOYEE_PASSWORD),
                "role": "employee",
                "display_name": f"Employee {i}",
                "created_at": now_iso(),
            })

    # backfill phone_norm on existing customers
    async for c in db.customers.find({"phone_norm": {"$exists": False}}, {"_id": 0, "id": 1, "phone": 1}):
        await db.customers.update_one(
            {"id": c["id"]},
            {"$set": {"phone_norm": norm_phone(c.get("phone", ""))}}
        )
    # backfill assigned_to for legacy customers → round-robin across employees
    emps = [u["username"] async for u in db.users.find({"role": "employee"}, {"_id": 0, "username": 1}).sort("username", 1)]
    if emps:
        i = 0
        async for c in db.customers.find({"assigned_to": {"$in": [None, ""]}}, {"_id": 0, "id": 1}):
            await db.customers.update_one({"id": c["id"]}, {"$set": {"assigned_to": emps[i % len(emps)]}})
            i += 1

    yield
    await _push_client.aclose()
    await _wa_client.aclose()
    client.close()


app = FastAPI(lifespan=lifespan)
api_router = APIRouter(prefix="/api")

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- Health checks (root + api for k8s liveness/readiness probes) ----------
@app.get("/health")
async def health_root():
    return {"status": "ok"}


@app.get("/")
async def root_ok():
    return {"status": "ok", "service": "pritha-cabinet"}

# ---------- Push helper (same as before) ----------
async def send_push(recipients: List[str], data: dict, idempotency_key: Optional[str] = None) -> None:
    if not recipients:
        return
    if len(recipients) > 100:
        raise ValueError("max 100 recipients")
    payload = {"recipients": recipients, "data": data}
    if idempotency_key:
        payload["$idempotency_key"] = idempotency_key
    resp = await _push_client.post("/api/v1/push/trigger", json=payload)
    if resp.status_code >= 500:
        raise HTTPException(502, "Push provider unavailable")
    resp.raise_for_status()

async def _notify_user(user_id: str, title: str, message: str, extra: Optional[dict] = None, idem: Optional[str] = None):
    try:
        docs = await db.push_users.find({"user_id": user_id}, {"_id": 0, "user_id": 1}).to_list(50)
        recipients = list({d["user_id"] for d in docs})
        if not recipients:
            return
        data = {"title": title, "message": message}
        if extra:
            data.update(extra)
        await send_push(recipients, data, idempotency_key=idem)
    except Exception as e:
        logger.warning(f"Push failed (non-blocking): {e}")

# ---------- WhatsApp helper ----------
async def send_whatsapp_template(to_phone: str, name: str, template_name: str, lang_code: str) -> bool:
    if META_TOKEN == "placeholder" or META_PHONE_ID == "placeholder":
        logger.info(f"[WA STUB] Would send template '{template_name}' to {to_phone} (name={name}). Set META_WA_ACCESS_TOKEN + META_WA_PHONE_NUMBER_ID to enable.")
        return False
    digits = norm_phone(to_phone)
    if not digits:
        return False
    url = f"https://graph.facebook.com/{META_API_VER}/{META_PHONE_ID}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": digits,
        "type": "template",
        "template": {
            "name": template_name,
            "language": {"code": lang_code},
            "components": [
                {
                    "type": "body",
                    "parameters": [{"type": "text", "text": name or "Customer"}],
                }
            ],
        },
    }
    try:
        resp = await _wa_client.post(
            url,
            headers={
                "Authorization": f"Bearer {META_TOKEN}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        if resp.status_code >= 400:
            logger.warning(f"WA send failed: {resp.status_code} {resp.text}")
            return False
        return True
    except Exception as e:
        logger.warning(f"WA send exception: {e}")
        return False

async def get_settings_doc() -> dict:
    doc = await db.settings.find_one({"id": "app"}, {"_id": 0})
    if not doc:
        return SettingsModel().dict()
    m = SettingsModel().dict()
    m.update({k: v for k, v in doc.items() if k in m})
    return m

def customer_from_doc(doc: dict) -> Customer:
    return Customer(
        id=doc["id"],
        name=doc.get("name", ""),
        phone=doc.get("phone", ""),
        address=doc.get("address", "") or "",
        notes=doc.get("notes", "") or "",
        status=doc.get("status", "pending"),
        assigned_to=doc.get("assigned_to"),
        last_called_at=doc.get("last_called_at"),
        followup_date=doc.get("followup_date"),
        rating=doc.get("rating"),
        feedback=doc.get("feedback", "") or "",
        whatsapp_sent_at=doc.get("whatsapp_sent_at"),
        created_at=doc.get("created_at", now_iso()),
    )

def user_public(u: dict) -> UserOut:
    return UserOut(
        id=u["id"],
        username=u["username"],
        role=u["role"],
        display_name=u.get("display_name"),
        daily_goal=u.get("daily_goal"),
    )

# ---------- Routes ----------
@api_router.get("/")
async def root():
    return {"message": "Pritha Cabinet API"}

@api_router.post("/auth/login")
async def login(body: LoginBody):
    user = await db.users.find_one({"username": body.username}, {"_id": 0})
    if not user or not verify_pw(body.password, user.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    return {"access_token": make_token(user), "user": user_public(user).dict()}

@api_router.get("/auth/me")
async def me(u=Depends(current_user)):
    return user_public(u).dict()

@api_router.get("/admin/users", response_model=List[UserOut])
async def list_users(_=Depends(admin_only)):
    users = await db.users.find({}, {"_id": 0}).sort("username", 1).to_list(50)
    return [user_public(u) for u in users]


USERNAME_RE = re.compile(r"^[a-zA-Z0-9_.-]{3,30}$")


async def cascade_rename_user(old: str, new: str):
    """Move all foreign-key references from old username → new username."""
    await db.users.update_one({"username": old}, {"$set": {"username": new}})
    await db.customers.update_many({"assigned_to": old}, {"$set": {"assigned_to": new}})
    await db.call_logs.update_many({"user": old}, {"$set": {"user": new}})
    await db.sales.update_many({"user": old}, {"$set": {"user": new}})
    await db.attendance.update_many({"user": old}, {"$set": {"user": new}})
    await db.expenses.update_many({"created_by": old}, {"$set": {"created_by": new}})
    await db.push_users.update_many({"user_id": old}, {"$set": {"user_id": new}})
    await db.collections.update_many({"user": old}, {"$set": {"user": new}})
    await db.daily_sales.update_many({"user": old}, {"$set": {"user": new}})
    # collector assignment in settings
    await db.settings.update_one({"id": "app", "collector_username": old}, {"$set": {"collector_username": new}})


@api_router.patch("/admin/users/{username}", response_model=UserOut)
async def admin_update_user(username: str, body: AdminUserUpdate, actor=Depends(admin_only)):
    user = await db.users.find_one({"username": username}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    updates: dict = {}
    if body.display_name is not None:
        name = body.display_name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Display name cannot be empty")
        if len(name) > 60:
            raise HTTPException(status_code=400, detail="Display name too long")
        updates["display_name"] = name
    if body.password is not None:
        pw = body.password.strip()
        if len(pw) < 4:
            raise HTTPException(status_code=400, detail="Password must be at least 4 characters")
        updates["password_hash"] = hash_pw(pw)
    if body.daily_goal is not None:
        if body.daily_goal < 1 or body.daily_goal > 1000:
            raise HTTPException(status_code=400, detail="Daily goal must be between 1 and 1000")
        updates["daily_goal"] = int(body.daily_goal)
    unset: dict = {}
    if body.reset_daily_goal:
        unset["daily_goal"] = ""

    new_username_final: Optional[str] = None
    if body.new_username is not None:
        new_u = body.new_username.strip().lower()
        if new_u != username:
            if not USERNAME_RE.match(new_u):
                raise HTTPException(status_code=400, detail="Username must be 3-30 chars: letters, digits, _.-")
            if await db.users.find_one({"username": new_u}, {"_id": 0}):
                raise HTTPException(status_code=409, detail="Username already taken")
            new_username_final = new_u

    if not updates and not unset and not new_username_final:
        raise HTTPException(status_code=400, detail="No changes provided")

    # apply $set / $unset first (still under old username)
    if updates or unset:
        mongo_ops: dict = {}
        if updates:
            mongo_ops["$set"] = updates
        if unset:
            mongo_ops["$unset"] = unset
        await db.users.update_one({"username": username}, mongo_ops)

    # then cascade rename if requested
    final_username = username
    if new_username_final:
        await cascade_rename_user(username, new_username_final)
        final_username = new_username_final

    updated = await db.users.find_one({"username": final_username}, {"_id": 0})
    return user_public(updated)


@api_router.post("/admin/users", response_model=UserOut)
async def admin_create_user(body: AdminUserCreate, _=Depends(admin_only)):
    new_u = body.username.strip().lower()
    if not USERNAME_RE.match(new_u):
        raise HTTPException(status_code=400, detail="Username must be 3-30 chars: letters, digits, _.-")
    if await db.users.find_one({"username": new_u}, {"_id": 0}):
        raise HTTPException(status_code=409, detail="Username already taken")
    pw = body.password.strip()
    if len(pw) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters")
    display = (body.display_name or "").strip() or new_u
    if len(display) > 60:
        raise HTTPException(status_code=400, detail="Display name too long")
    doc = {
        "id": str(uuid.uuid4()),
        "username": new_u,
        "password_hash": hash_pw(pw),
        "role": "employee",
        "display_name": display,
        "created_at": now_iso(),
    }
    if body.daily_goal is not None:
        if body.daily_goal < 1 or body.daily_goal > 1000:
            raise HTTPException(status_code=400, detail="Daily goal must be between 1 and 1000")
        doc["daily_goal"] = int(body.daily_goal)
    await db.users.insert_one(doc)
    return user_public(doc)


@api_router.delete("/admin/users/{username}")
async def admin_delete_user(
    username: str,
    reassign_to: Optional[str] = None,
    actor=Depends(admin_only),
):
    target = await db.users.find_one({"username": username}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target.get("role") == "admin":
        raise HTTPException(status_code=400, detail="Cannot delete an admin account")
    if username == actor["username"]:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")

    # If the user has assigned customers, we need somewhere to move them
    has_customers = await db.customers.count_documents({"assigned_to": username}) > 0
    if has_customers:
        if not reassign_to:
            raise HTTPException(status_code=400, detail="Provide reassign_to (username) to move this employee's customers")
        if reassign_to == username:
            raise HTTPException(status_code=400, detail="Reassign target cannot be the same user")
        r_user = await db.users.find_one({"username": reassign_to}, {"_id": 0})
        if not r_user or r_user.get("role") != "employee":
            raise HTTPException(status_code=400, detail="reassign_to must be another employee")
        moved = (await db.customers.update_many(
            {"assigned_to": username}, {"$set": {"assigned_to": reassign_to}}
        )).modified_count
    else:
        moved = 0

    # Delete or anonymize history?
    # Keep call_logs/sales/expenses for audit (they retain the old username as a plain string).
    await db.attendance.delete_many({"user": username})
    await db.push_users.delete_many({"user_id": username})
    # Also clear collector if this user was designated
    await db.settings.update_one({"id": "app", "collector_username": username}, {"$unset": {"collector_username": ""}})
    await db.users.delete_one({"username": username})
    return {"deleted": username, "customers_moved": moved, "reassigned_to": reassign_to if has_customers else None}


@api_router.get("/admin/team-stats")
async def admin_team_stats(_=Depends(admin_only)):
    """Per-employee snapshot for today: calls, sales, revenue, attendance, goal."""
    day = today_key()
    settings = await get_settings_doc()
    default_goal = settings.get("daily_goal", 50)

    users = await db.users.find(
        {"role": "employee"},
        {"_id": 0, "id": 1, "username": 1, "display_name": 1, "daily_goal": 1},
    ).sort("username", 1).to_list(50)

    # calls today per user
    calls_agg = await db.call_logs.aggregate([
        {"$match": {"date_key": day}},
        {"$group": {"_id": "$user", "total": {"$sum": 1}}},
    ]).to_list(200)
    calls_map = {row["_id"]: row["total"] for row in calls_agg}

    # sales today per user
    sales_agg = await db.sales.aggregate([
        {"$match": {"date_key": day}},
        {"$group": {
            "_id": "$user",
            "sales_count": {"$sum": 1},
            "revenue": {"$sum": "$amount"},
        }},
    ]).to_list(200)
    sales_map = {row["_id"]: row for row in sales_agg}

    # attendance today per user
    att_docs = await db.attendance.find(
        {"date_key": day},
        {"_id": 0, "user": 1, "check_in": 1, "check_out": 1},
    ).to_list(50)
    att_map = {a["user"]: a for a in att_docs}

    # total assigned customers per user
    cust_agg = await db.customers.aggregate([
        {"$group": {"_id": "$assigned_to", "count": {"$sum": 1}}},
    ]).to_list(200)
    cust_map = {row["_id"]: row["count"] for row in cust_agg}

    rows = []
    for user in users:
        uname = user["username"]
        user_goal = int(user.get("daily_goal") or default_goal)
        att = att_map.get(uname)
        if not att:
            att_status = "absent"
        elif att.get("check_out"):
            att_status = "done"
        elif att.get("check_in"):
            att_status = "active"
        else:
            att_status = "absent"
        s = sales_map.get(uname, {})
        total_calls = calls_map.get(uname, 0)
        rows.append({
            "id": user["id"],
            "username": uname,
            "display_name": user.get("display_name", uname),
            "daily_goal": user_goal,
            "is_custom_goal": bool(user.get("daily_goal")),
            "calls": total_calls,
            "pct": min(1.0, total_calls / user_goal) if user_goal else 0,
            "sales_count": s.get("sales_count", 0),
            "revenue": s.get("revenue", 0.0),
            "attendance": att_status,
            "check_in": att.get("check_in") if att else None,
            "check_out": att.get("check_out") if att else None,
            "customers_total": cust_map.get(uname, 0),
        })

    return {"date": day, "default_goal": default_goal, "rows": rows}

@api_router.post("/admin/reassign")
async def reassign(body: ReassignBody, _=Depends(admin_only)):
    if not await db.users.find_one({"username": body.new_owner}):
        raise HTTPException(status_code=400, detail="Unknown employee")
    result = await db.customers.update_many(
        {"id": {"$in": body.customer_ids}},
        {"$set": {"assigned_to": body.new_owner}},
    )
    return {"updated": result.modified_count}


@api_router.get("/admin/users/{username}/calls")
async def admin_user_calls(
    username: str,
    limit: int = 100,
    _=Depends(admin_only),
):
    """List call logs for a given user, newest first."""
    if not await db.users.find_one({"username": username}, {"_id": 0}):
        raise HTTPException(status_code=404, detail="User not found")
    limit = max(1, min(limit, 500))
    docs = (
        await db.call_logs.find({"user": username}, {"_id": 0})
        .sort("timestamp", -1)
        .limit(limit)
        .to_list(limit)
    )
    return docs


@api_router.get("/admin/users/{username}/sales", response_model=List[Sale])
async def admin_user_sales(
    username: str,
    limit: int = 100,
    _=Depends(admin_only),
):
    """List sales for a given user, newest first."""
    if not await db.users.find_one({"username": username}, {"_id": 0}):
        raise HTTPException(status_code=404, detail="User not found")
    limit = max(1, min(limit, 500))
    docs = (
        await db.sales.find({"user": username}, {"_id": 0})
        .sort("timestamp", -1)
        .limit(limit)
        .to_list(limit)
    )
    return [sale_from_doc(d) for d in docs]


@api_router.post("/admin/calls/reassign")
async def admin_reassign_calls(body: ReassignItemsBody, _=Depends(admin_only)):
    """Move selected call log entries to another employee."""
    if not body.ids:
        raise HTTPException(status_code=400, detail="No calls selected")
    target = await db.users.find_one({"username": body.new_owner}, {"_id": 0})
    if not target or target.get("role") != "employee":
        raise HTTPException(status_code=400, detail="new_owner must be an employee")
    result = await db.call_logs.update_many(
        {"id": {"$in": body.ids}},
        {"$set": {"user": body.new_owner}},
    )
    return {"updated": result.modified_count}


@api_router.post("/admin/sales/reassign")
async def admin_reassign_sales(body: ReassignItemsBody, _=Depends(admin_only)):
    """Move selected sale records to another employee."""
    if not body.ids:
        raise HTTPException(status_code=400, detail="No sales selected")
    target = await db.users.find_one({"username": body.new_owner}, {"_id": 0})
    if not target or target.get("role") != "employee":
        raise HTTPException(status_code=400, detail="new_owner must be an employee")
    # Also update the cached display_name
    result = await db.sales.update_many(
        {"id": {"$in": body.ids}},
        {"$set": {
            "user": body.new_owner,
            "display_name": target.get("display_name") or body.new_owner,
        }},
    )
    return {"updated": result.modified_count}


@api_router.delete("/admin/calls/{cid}")
async def admin_delete_call(cid: str, _=Depends(admin_only)):
    """Admin removes any call log entry."""
    res = await db.call_logs.delete_one({"id": cid})
    if res.deleted_count == 0:
        raise HTTPException(404, "Not found")
    return {"deleted": True}


# ---------- Customers ----------
@api_router.get("/customers/lookup")
async def lookup_customer(phone: str, u=Depends(current_user)):
    """Return existing customer for a phone number (helps duplicate-phone handoff)."""
    phone_n = norm_phone(phone)
    if not phone_n:
        raise HTTPException(400, "Invalid phone")
    doc = await db.customers.find_one({"phone_norm": phone_n}, {"_id": 0})
    if not doc:
        return {"exists": False}
    c = customer_from_doc(doc).dict()
    # Flag if it's already the current user's customer
    c["is_mine"] = doc.get("assigned_to") == u["username"]
    return {"exists": True, "customer": c}


@api_router.get("/customers/search")
async def search_customers(q: str = "", limit: int = 20, u=Depends(current_user)):
    """Free-text search across ALL customers (any assignee) by name OR phone.
    Powers the Customer Ledger search widget and Existing-Customer picker.
    - Case-insensitive partial match on name.
    - Digit-only partial match on phone_norm (falls back to plain phone regex).
    - Returns up to `limit` results, newest first.
    Access: all authenticated users (per business rule: any employee may pull any customer).
    """
    q = (q or "").strip()
    if not q:
        return {"customers": [], "count": 0}
    digits = re.sub(r"\D", "", q)
    or_clauses: List[dict] = [{"name": {"$regex": re.escape(q), "$options": "i"}}]
    if digits:
        or_clauses.append({"phone_norm": {"$regex": re.escape(digits)}})
        or_clauses.append({"phone": {"$regex": re.escape(digits)}})
    lim = max(1, min(int(limit or 20), 100))
    docs = await db.customers.find({"$or": or_clauses}, {"_id": 0}).sort("created_at", -1).to_list(lim)
    out = []
    for d in docs:
        c = customer_from_doc(d).dict()
        c["is_mine"] = d.get("assigned_to") == u["username"]
        c["assigned_to"] = d.get("assigned_to")
        out.append(c)
    return {"customers": out, "count": len(out)}


@api_router.get("/customers/{cust_id}/ledger")
async def customer_ledger(cust_id: str, u=Depends(current_user)):
    """Running statement for a customer combining sales, invoices, and money receipts.
    Match strategy: customer_id first, then phone number for legacy records without id link.
    """
    cust = await db.customers.find_one({"id": cust_id}, {"_id": 0})
    if not cust:
        raise HTTPException(404, "Customer not found")
    phone_n = cust.get("phone_norm") or norm_phone(cust.get("phone", ""))
    phone_variants = list({cust.get("phone", ""), phone_n} - {""}) if phone_n else [cust.get("phone", "")]

    # Sales — by customer_id first
    sales_q: dict = {"$or": [{"customer_id": cust_id}]}
    if phone_variants:
        # legacy: sales may not have customer_id — no direct phone field on sales, skip phone fallback
        pass
    sales = await db.sales.find({"customer_id": cust_id}, {"_id": 0}).sort("timestamp", -1).to_list(500)

    # Invoices — by customer_id OR by phone (normalized best-effort)
    inv_query = {"$or": [{"customer_id": cust_id}]}
    if phone_variants:
        inv_query["$or"].append({"customer_mobile": {"$in": phone_variants}})
    invoices = await db.invoices.find(inv_query, {"_id": 0}).sort("created_at", -1).to_list(500)

    # Receipts — no customer_id field; match by phone or by source_id in the above sales/invoices
    src_ids = [s["id"] for s in sales] + [iv["id"] for iv in invoices]
    rc_or: List[dict] = []
    if phone_variants:
        rc_or.append({"customer_mobile": {"$in": phone_variants}})
    if src_ids:
        rc_or.append({"source_id": {"$in": src_ids}})
    receipts = []
    if rc_or:
        receipts = await db.receipts.find({"$or": rc_or}, {"_id": 0}).sort("created_at", -1).to_list(500)

    # attach pdf tokens + display
    name_cache: dict = {}
    async def _nm(uname: str) -> str:
        if uname not in name_cache:
            name_cache[uname] = await _display_name_for(uname)
        return name_cache[uname]
    for iv in invoices:
        iv["display_name"] = await _nm(iv["user"])
        if iv.get("pdf_path"):
            iv["pdf_token"] = _make_media_token(iv["pdf_path"])
    for r in receipts:
        r["display_name"] = await _nm(r["user"])
        if r.get("pdf_path"):
            r["pdf_token"] = _make_media_token(r["pdf_path"])

    # Build unified timeline events
    def _iso_dt(s: str) -> str:
        return s or ""
    timeline: List[dict] = []
    rc_by_src: dict = {}
    for r in receipts:
        if r.get("source_id"):
            rc_by_src.setdefault(r["source_id"], []).append(
                {"id": r["id"], "receipt_no": r["receipt_no"], "amount": float(r.get("amount") or 0), "pdf_token": r.get("pdf_token")}
            )
    for s in sales:
        timeline.append({
            "kind": "sale",
            "id": s["id"],
            "when": s.get("timestamp") or s.get("date_key"),
            "amount": float(s.get("amount") or 0),
            "title": f"Sale · {s.get('product') or ''}".strip(" ·"),
            "by": await _nm(s["user"]),
            "notes": s.get("notes") or "",
            "invoice_no": s.get("invoice_no"),
            "source": s.get("source", "manual"),
            "payment_mode": s.get("payment_mode"),
            "receipts": rc_by_src.get(s["id"], []),
        })
    for iv in invoices:
        timeline.append({
            "kind": "invoice",
            "id": iv["id"],
            "when": iv.get("created_at") or iv.get("date_key"),
            "amount": float(iv.get("total") or 0),
            "title": f"Invoice {iv['invoice_no']}",
            "by": iv.get("display_name"),
            "notes": iv.get("notes") or "",
            "pdf_token": iv.get("pdf_token"),
            "items_count": len(iv.get("items") or []),
        })
    for r in receipts:
        timeline.append({
            "kind": "receipt",
            "id": r["id"],
            "when": r.get("created_at") or r.get("date_key"),
            "amount": float(r.get("amount") or 0),
            "title": f"Receipt {r['receipt_no']}",
            "by": r.get("display_name"),
            "notes": r.get("narration") or r.get("notes") or "",
            "pdf_token": r.get("pdf_token"),
            "payment_mode": r.get("payment_mode"),
            "source_type": r.get("source_type"),
            "source_label": r.get("source_label"),
        })
    timeline.sort(key=lambda x: _iso_dt(x.get("when") or ""), reverse=True)

    total_billed_all_sales = float(sum(s.get("amount", 0) for s in sales))
    # Exclude legacy invoice-auto-sales to avoid double-count with invoices below
    total_billed_no_inv_dup = float(sum(s.get("amount", 0) for s in sales if s.get("source") != "invoice"))
    total_invoices = float(sum(iv.get("total", 0) for iv in invoices))
    total_received = float(sum(r.get("amount", 0) for r in receipts))

    # Invoices are independent — "Billed" shown to the user = manual sales + invoices.
    total_billed = total_billed_no_inv_dup + total_invoices
    due_balance = total_billed - total_received

    return {
        "customer": customer_from_doc(cust).dict(),
        "summary": {
            "total_billed": total_billed,
            "total_billed_manual": total_billed_no_inv_dup,
            "total_sales_raw": total_billed_all_sales,
            "total_invoices": total_invoices,
            "total_received": total_received,
            "due_balance": due_balance,
        },
        "timeline": timeline,
        "counts": {
            "sales": len(sales),
            "invoices": len(invoices),
            "receipts": len(receipts),
        },
    }


@api_router.post("/customers", response_model=Customer)
async def create_customer(payload: CustomerCreate, u=Depends(current_user)):
    phone_n = norm_phone(payload.phone)
    if not phone_n:
        raise HTTPException(400, "Invalid phone")
    if await db.customers.find_one({"phone_norm": phone_n}):
        raise HTTPException(409, "Phone number already exists")

    assigned = payload.assigned_to
    if u["role"] == "admin":
        if assigned and not await db.users.find_one({"username": assigned}):
            raise HTTPException(400, "Unknown assignee")
    else:
        assigned = u["username"]
    if not assigned:
        assigned = u["username"]

    doc = {
        "id": str(uuid.uuid4()),
        "name": payload.name,
        "phone": payload.phone,
        "phone_norm": phone_n,
        "address": (payload.address or "").strip(),
        "notes": (payload.notes or "").strip(),
        "status": "pending",
        "assigned_to": assigned,
        "created_at": now_iso(),
    }
    await db.customers.insert_one(doc)
    return customer_from_doc(doc)

@api_router.post("/customers/bulk")
async def bulk_create(payload: BulkCreate, u=Depends(current_user)):
    if not payload.customers:
        return {"inserted": 0, "duplicates": 0}

    # who to round-robin across?
    if u["role"] == "admin":
        emps = [x["username"] async for x in db.users.find({"role": "employee"}, {"_id": 0, "username": 1}).sort("username", 1)]
        if not emps:
            emps = [u["username"]]
    else:
        emps = [u["username"]]

    inserted = 0
    duplicates = 0
    for i, c in enumerate(payload.customers):
        phone_n = norm_phone(c.phone)
        if not phone_n:
            duplicates += 1
            continue
        if await db.customers.find_one({"phone_norm": phone_n}):
            duplicates += 1
            continue
        assignee = emps[i % len(emps)]
        doc = {
            "id": str(uuid.uuid4()),
            "name": c.name or c.phone,
            "phone": c.phone,
            "phone_norm": phone_n,
            "notes": c.notes or "",
            "status": "pending",
            "assigned_to": assignee,
            "created_at": now_iso(),
        }
        try:
            await db.customers.insert_one(doc)
            inserted += 1
        except Exception:
            duplicates += 1

    return {"inserted": inserted, "duplicates": duplicates}


@api_router.post("/customers/preview-bulk")
async def preview_bulk(payload: BulkCreate, u=Depends(current_user)):
    """Return per-row status (new/duplicate) without inserting anything."""
    if u["role"] == "admin":
        emps = [x["username"] async for x in db.users.find({"role": "employee"}, {"_id": 0, "username": 1}).sort("username", 1)]
        if not emps:
            emps = [u["username"]]
    else:
        emps = [u["username"]]

    seen_in_batch: set = set()
    rows: List[dict] = []
    new_count = 0
    dup_count = 0
    for i, c in enumerate(payload.customers):
        phone_n = norm_phone(c.phone)
        if not phone_n:
            reason = "invalid_phone"
            status = "duplicate"
        elif phone_n in seen_in_batch:
            reason = "repeated_in_batch"
            status = "duplicate"
        elif await db.customers.find_one({"phone_norm": phone_n}, {"_id": 0, "assigned_to": 1}):
            reason = "already_in_system"
            status = "duplicate"
        else:
            reason = None
            status = "new"
            seen_in_batch.add(phone_n)

        if status == "new":
            new_count += 1
        else:
            dup_count += 1

        rows.append({
            "index": i,
            "name": c.name or c.phone,
            "phone": c.phone,
            "phone_norm": phone_n,
            "status": status,
            "reason": reason,
            "assignee_preview": emps[(new_count - 1) % len(emps)] if status == "new" and emps else None,
        })
    return {"total": len(rows), "new": new_count, "duplicates": dup_count, "rows": rows}


@api_router.get("/customers", response_model=List[Customer])
async def list_customers(
    status: Optional[str] = None,
    search: Optional[str] = None,
    scope: Optional[str] = "mine",
    u=Depends(current_user),
):
    query: dict = {}
    # Default list is scoped to the signed-in employee's own customers (their daily call
    # list). But when a search term is provided, allow every employee to look up ANY
    # customer across the workspace by name or phone.
    if (u["role"] != "admin" or scope == "mine") and not search:
        query["assigned_to"] = u["username"]
    if status and status != "all":
        query["status"] = status
    if search:
        query["$or"] = [
            {"name": {"$regex": re.escape(search), "$options": "i"}},
            {"phone": {"$regex": re.escape(search), "$options": "i"}},
        ]
    docs = await db.customers.find(query, {"_id": 0}).sort("created_at", 1).to_list(5000)
    return [customer_from_doc(d) for d in docs]

class CustomerPatchBody(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    notes: Optional[str] = None


@api_router.patch("/customers/{cid}", response_model=Customer)
async def update_customer(cid: str, body: CustomerPatchBody, u=Depends(current_user)):
    """Edit customer details (name / phone / address / note). Any signed-in employee may edit
    (business rule: every employee can work any customer); phone stays unique."""
    doc = await db.customers.find_one({"id": cid}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Customer not found")
    upd: dict = {}
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(400, "Name cannot be empty")
        upd["name"] = body.name.strip()
    if body.phone is not None:
        phone_n = norm_phone(body.phone)
        if not phone_n:
            raise HTTPException(400, "Invalid phone")
        dup = await db.customers.find_one({"phone_norm": phone_n, "id": {"$ne": cid}}, {"_id": 0, "id": 1, "name": 1})
        if dup:
            raise HTTPException(409, f"Phone number already belongs to {dup.get('name') or 'another customer'}")
        upd["phone"] = body.phone.strip()
        upd["phone_norm"] = phone_n
    if body.address is not None:
        upd["address"] = body.address.strip()
    if body.notes is not None:
        upd["notes"] = body.notes.strip()
    if not upd:
        raise HTTPException(400, "No changes")
    upd["updated_at"] = now_iso()
    upd["updated_by"] = u["username"]
    await db.customers.update_one({"id": cid}, {"$set": upd})
    fresh = await db.customers.find_one({"id": cid}, {"_id": 0})
    # Keep names in sync on documents that embed the customer
    if "name" in upd or "phone" in upd:
        sync = {}
        if "name" in upd:
            sync["customer_name"] = upd["name"]
        if "phone" in upd:
            sync["customer_mobile"] = upd["phone"]
        await db.invoices.update_many({"customer_id": cid}, {"$set": sync})
        await db.receipts.update_many({"customer_id": cid}, {"$set": sync})
        if "name" in upd:
            await db.sales.update_many({"customer_id": cid}, {"$set": {"customer_name": upd["name"]}})
    return customer_from_doc(fresh)



@api_router.patch("/customers/{cid}/status", response_model=Customer)
async def update_status(cid: str, body: StatusUpdate, u=Depends(current_user)):
    if body.status not in VALID_STATUS:
        raise HTTPException(400, "Invalid status")
    query = {"id": cid}
    if u["role"] != "admin":
        query["assigned_to"] = u["username"]

    update = {"status": body.status, "last_called_at": now_iso()}
    settings = await get_settings_doc()

    if body.status == "interested":
        d = settings.get("follow_up_days", 3)
        update["followup_date"] = (datetime.now(timezone.utc) + timedelta(days=d)).strftime("%Y-%m-%d")
    elif body.status == "callback":
        update["followup_date"] = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%d")

    result = await db.customers.find_one_and_update(
        query, {"$set": update}, return_document=True, projection={"_id": 0}
    )
    if not result:
        raise HTTPException(404, "Customer not found")

    await db.call_logs.insert_one({
        "id": str(uuid.uuid4()),
        "customer_id": cid,
        "customer_name": result.get("name", ""),
        "phone": result.get("phone", ""),
        "status": body.status,
        "date_key": today_key(),
        "user": u["username"],
        "timestamp": now_iso(),
    })

    day = today_key()
    total_today = await db.call_logs.count_documents({"date_key": day, "user": u["username"]})
    goal = settings.get("daily_goal", 50)

    # Auto WhatsApp on interested
    if body.status == "interested":
        ok = await send_whatsapp_template(
            to_phone=result["phone"],
            name=result.get("name", "Customer"),
            template_name=settings.get("whatsapp_template_name", "hello_world"),
            lang_code=settings.get("whatsapp_language_code", "en_US"),
        )
        if ok:
            await db.customers.update_one({"id": cid}, {"$set": {"whatsapp_sent_at": now_iso()}})
            result["whatsapp_sent_at"] = now_iso()
        await _notify_user(
            u["username"],
            "Interested customer",
            f"{result.get('name','Customer')} marked interested. Follow-up on {update.get('followup_date','')}",
            extra={"action_url": "/(tabs)/followups"},
            idem=f"int-{cid}-{day}",
        )
    elif body.status == "callback":
        await _notify_user(
            u["username"],
            "Callback scheduled",
            f"Remember to call {result.get('name','a customer')} back tomorrow.",
            extra={"action_url": "/(tabs)/followups"},
            idem=f"cb-{cid}-{day}",
        )
    if total_today == goal:
        await _notify_user(
            u["username"], f"🎉 {goal} calls done!", "You hit today's target!",
            extra={"action_url": "/(tabs)/progress"}, idem=f"goal-{u['username']}-{day}",
        )
    elif goal >= 20 and total_today == goal // 2:
        await _notify_user(
            u["username"], f"Halfway there — {total_today}/{goal}", "Keep going!",
            extra={"action_url": "/(tabs)/progress"}, idem=f"half-{u['username']}-{day}",
        )

    return customer_from_doc(result)

@api_router.post("/customers/{cid}/feedback", response_model=Customer)
async def add_feedback(cid: str, body: FeedbackBody, u=Depends(current_user)):
    query = {"id": cid}
    if u["role"] != "admin":
        query["assigned_to"] = u["username"]
    result = await db.customers.find_one_and_update(
        query,
        {"$set": {"rating": body.rating, "feedback": body.notes or "", "feedback_at": now_iso()}},
        return_document=True,
        projection={"_id": 0},
    )
    if not result:
        raise HTTPException(404, "Customer not found")
    return customer_from_doc(result)

@api_router.delete("/customers/{cid}")
async def delete_customer(cid: str, u=Depends(current_user)):
    query = {"id": cid}
    if u["role"] != "admin":
        query["assigned_to"] = u["username"]
    res = await db.customers.delete_one(query)
    if res.deleted_count == 0:
        raise HTTPException(404, "Not found")
    return {"deleted": True}

@api_router.delete("/customers")
async def clear_all(_=Depends(admin_only)):
    await db.customers.delete_many({})
    return {"cleared": True}

# ---------- Follow-ups ----------
@api_router.get("/followups", response_model=List[Customer])
async def followups(u=Depends(current_user)):
    query: dict = {"status": {"$in": ["interested", "callback"]}}
    if u["role"] != "admin":
        query["assigned_to"] = u["username"]
    docs = await db.customers.find(query, {"_id": 0}).sort("followup_date", 1).to_list(2000)
    return [customer_from_doc(d) for d in docs]

# ---------- Stats ----------
@api_router.get("/stats/today")
async def stats_today(u=Depends(current_user)):
    day = today_key()
    settings = await get_settings_doc()
    default_goal = settings.get("daily_goal", 50)
    # per-user override
    goal = int(u.get("daily_goal") or default_goal)

    match = {"date_key": day}
    if u["role"] != "admin":
        match["user"] = u["username"]

    pipeline = [{"$match": match}, {"$group": {"_id": "$status", "count": {"$sum": 1}}}]
    agg = await db.call_logs.aggregate(pipeline).to_list(50)
    breakdown = {s: 0 for s in VALID_STATUS}
    total = 0
    for row in agg:
        if row["_id"] in breakdown:
            breakdown[row["_id"]] = row["count"]
        total += row["count"]

    cust_query = {"status": "pending"}
    total_query: dict = {}
    if u["role"] != "admin":
        cust_query["assigned_to"] = u["username"]
        total_query["assigned_to"] = u["username"]
    pending_count = await db.customers.count_documents(cust_query)
    total_customers = await db.customers.count_documents(total_query)

    return {
        "date": day,
        "goal": goal,
        "total_calls": total,
        "breakdown": breakdown,
        "pending_customers": pending_count,
        "total_customers": total_customers,
    }

@api_router.get("/stats/history")
async def stats_history(u=Depends(current_user), days: int = 30):
    match: dict = {}
    if u["role"] != "admin":
        match["user"] = u["username"]
    pipeline = [
        {"$match": match},
        {"$group": {"_id": {"date": "$date_key", "status": "$status"}, "count": {"$sum": 1}}},
        {"$sort": {"_id.date": -1}},
    ]
    agg = await db.call_logs.aggregate(pipeline).to_list(1000)
    days_map: dict = {}
    for row in agg:
        d = row["_id"]["date"]
        s = row["_id"]["status"]
        c = row["count"]
        if d not in days_map:
            days_map[d] = {"date": d, "total": 0, "breakdown": {k: 0 for k in VALID_STATUS}}
        days_map[d]["total"] += c
        if s in days_map[d]["breakdown"]:
            days_map[d]["breakdown"][s] = c
    ordered = sorted(days_map.values(), key=lambda x: x["date"], reverse=True)[:days]
    return {"history": ordered}


@api_router.get("/stats/leaderboard")
async def stats_leaderboard(u=Depends(current_user)):
    """Today's ranking of every employee by total calls made."""
    day = today_key()
    settings = await get_settings_doc()
    default_goal = settings.get("daily_goal", 50)

    pipeline = [
        {"$match": {"date_key": day}},
        {"$group": {
            "_id": "$user",
            "total": {"$sum": 1},
            "interested": {"$sum": {"$cond": [{"$eq": ["$status", "interested"]}, 1, 0]}},
        }},
    ]
    agg = await db.call_logs.aggregate(pipeline).to_list(200)
    counts = {row["_id"]: row for row in agg}

    # Sales aggregation for today
    sales_pipeline = [
        {"$match": {"date_key": day}},
        {"$group": {"_id": "$user", "sales_count": {"$sum": 1}, "revenue": {"$sum": "$amount"}}},
    ]
    sales_agg = await db.sales.aggregate(sales_pipeline).to_list(200)
    sales_map = {row["_id"]: row for row in sales_agg}

    users = await db.users.find(
        {"role": "employee"},
        {"_id": 0, "username": 1, "display_name": 1, "daily_goal": 1},
    ).sort("username", 1).to_list(50)
    rows = []
    for user in users:
        c = counts.get(user["username"], {})
        s = sales_map.get(user["username"], {})
        total = c.get("total", 0)
        interested = c.get("interested", 0)
        user_goal = int(user.get("daily_goal") or default_goal)
        rows.append({
            "username": user["username"],
            "display_name": user.get("display_name", user["username"]),
            "total": total,
            "interested": interested,
            "sales_count": s.get("sales_count", 0),
            "revenue": s.get("revenue", 0.0),
            "goal": user_goal,
            "pct": min(1.0, total / user_goal) if user_goal else 0,
            "is_me": user["username"] == u["username"],
        })
    rows.sort(key=lambda r: (-r["sales_count"], -r["total"], -r["interested"], r["username"]))
    for i, r in enumerate(rows):
        r["rank"] = i + 1
    return {"date": day, "goal": default_goal, "rows": rows}



# ---------- Settings ----------
@api_router.get("/settings")
async def get_settings(_=Depends(current_user)):
    return await get_settings_doc()

@api_router.patch("/settings")
async def update_settings(payload: SettingsUpdate, _=Depends(admin_only)):
    upd = {k: v for k, v in payload.dict().items() if v is not None}
    if not upd:
        return await get_settings_doc()
    await db.settings.update_one({"id": "app"}, {"$set": {"id": "app", **upd}}, upsert=True)
    return await get_settings_doc()


# ---------- Daily Due Collection ----------
def _cash_total_from_denoms(denoms: dict) -> float:
    total = 0.0
    for d in DENOMS:
        try:
            pcs = int(denoms.get(str(d), 0) or 0)
        except (TypeError, ValueError):
            pcs = 0
        if pcs < 0:
            pcs = 0
        total += pcs * d
    return float(total)


def _clean_denoms(denoms: dict) -> dict:
    """Normalize incoming denomination dict to just the allowed keys."""
    out: dict = {}
    for d in DENOMS:
        try:
            pcs = int(denoms.get(str(d), 0) or 0)
        except (TypeError, ValueError):
            pcs = 0
        if pcs < 0:
            pcs = 0
        out[str(d)] = pcs
    return out


async def _current_collector_username() -> Optional[str]:
    settings = await get_settings_doc()
    return settings.get("collector_username")


async def _display_name_for(username: str) -> str:
    u = await db.users.find_one({"username": username}, {"_id": 0, "display_name": 1, "username": 1})
    if not u:
        return username
    return u.get("display_name") or u.get("username") or username


@api_router.get("/collector")
async def get_collector(_=Depends(current_user)):
    """Anyone can see who the current collector is (surface in More menu)."""
    uname = await _current_collector_username()
    if not uname:
        return {"collector": None}
    doc = await db.users.find_one({"username": uname}, {"_id": 0, "id": 1, "username": 1, "role": 1, "display_name": 1})
    return {"collector": user_public(doc).model_dump() if doc else None}


@api_router.put("/admin/collector")
async def set_collector(body: CollectorAssignBody, _=Depends(admin_only)):
    """Admin assigns (or clears) the daily collection collector."""
    uname = (body.username or "").strip().lower() if body.username else None
    if uname:
        target = await db.users.find_one({"username": uname}, {"_id": 0})
        if not target or target.get("role") != "employee":
            raise HTTPException(400, "Collector must be an existing employee")
        await db.settings.update_one({"id": "app"}, {"$set": {"id": "app", "collector_username": uname}}, upsert=True)
    else:
        await db.settings.update_one({"id": "app"}, {"$unset": {"collector_username": ""}}, upsert=True)
    return await get_collector()


@api_router.post("/collections", response_model=CollectionEntry)
async def create_collection(body: CollectionEntryBody, u=Depends(current_user)):
    """Create a daily collection entry. Any authenticated employee/admin may post.
    Simple cash + online direct entry (no denomination breakdown).
    """
    date_key = (body.date_key or today_key()).strip()
    cash_total = float(max(0.0, body.cash_total or 0))
    online_total = float(max(0.0, body.online_total or 0))
    grand = cash_total + online_total
    now = now_iso()
    doc = {
        "id": str(uuid.uuid4()),
        "user": u["username"],
        "date_key": date_key,
        "denominations": {},  # not used for new collections
        "cash_total": cash_total,
        "online_total": online_total,
        "grand_total": grand,
        "notes": (body.notes or "").strip(),
        "created_at": now,
        "updated_at": now,
    }
    await db.collections.insert_one(doc)
    doc.pop("_id", None)
    doc["display_name"] = await _display_name_for(doc["user"])
    return CollectionEntry(**doc)


@api_router.get("/collections", response_model=List[CollectionEntry])
async def list_collections(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    limit: int = 100,
    u=Depends(current_user),
):
    """Workspace-wide visibility for the whole team; any authenticated employee may POST/PATCH their own entries."""
    q: dict = {}
    if from_date or to_date:
        r: dict = {}
        if from_date:
            r["$gte"] = from_date
        if to_date:
            r["$lte"] = to_date
        q["date_key"] = r
    limit = max(1, min(500, limit))
    docs = (
        await db.collections.find(q, {"_id": 0})
        .sort([("date_key", -1), ("created_at", -1)])
        .limit(limit)
        .to_list(limit)
    )
    # Attach display names
    name_cache: dict = {}
    for d in docs:
        uname = d["user"]
        if uname not in name_cache:
            name_cache[uname] = await _display_name_for(uname)
        d["display_name"] = name_cache[uname]

    # Attach linked receipts for duplicate prevention
    ids = [d["id"] for d in docs]
    if ids:
        r_cursor = db.receipts.find(
            {"source_type": "collection", "source_id": {"$in": ids}},
            {"_id": 0, "id": 1, "receipt_no": 1, "source_id": 1, "amount": 1, "payment_mode": 1, "pdf_path": 1, "reference_no": 1},
        )
        by_src: dict = {}
        async for r in r_cursor:
            by_src.setdefault(r["source_id"], []).append({
                "id": r["id"],
                "receipt_no": r["receipt_no"],
                "amount": float(r.get("amount") or 0),
                "payment_mode": (r.get("payment_mode") or "cash").lower(),
                "reference_no": r.get("reference_no") or "",
                "pdf_token": _make_media_token(r["pdf_path"]) if r.get("pdf_path") else None,
            })
        for d in docs:
            d["linked_receipts"] = by_src.get(d["id"], [])
    return [CollectionEntry(**d) for d in docs]


@api_router.patch("/collections/{cid}", response_model=CollectionEntry)
async def update_collection(cid: str, body: CollectionEntryBody, u=Depends(current_user)):
    """Owner or admin can edit."""
    doc = await db.collections.find_one({"id": cid}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Entry not found")
    if u["role"] != "admin" and doc["user"] != u["username"]:
        raise HTTPException(403, "You can only edit your own entries")
    upd: dict = {}
    if body.date_key is not None:
        upd["date_key"] = body.date_key.strip()
    if body.cash_total is not None:
        upd["cash_total"] = float(max(0.0, body.cash_total))
        upd["denominations"] = {}  # clear legacy denoms when editing to direct amount
    if body.online_total is not None:
        upd["online_total"] = float(max(0.0, body.online_total))
    if body.notes is not None:
        upd["notes"] = body.notes.strip()
    if not upd:
        raise HTTPException(400, "No changes")
    # recalc grand
    cash = upd.get("cash_total", doc.get("cash_total", 0))
    online = upd.get("online_total", doc.get("online_total", 0))
    upd["grand_total"] = float(cash) + float(online)
    upd["updated_at"] = now_iso()
    await db.collections.update_one({"id": cid}, {"$set": upd})
    fresh = await db.collections.find_one({"id": cid}, {"_id": 0})
    fresh["display_name"] = await _display_name_for(fresh["user"])
    return CollectionEntry(**fresh)


@api_router.delete("/collections/{cid}")
async def delete_collection(cid: str, _=Depends(admin_only)):
    res = await db.collections.delete_one({"id": cid})
    if res.deleted_count == 0:
        raise HTTPException(404, "Not found")
    return {"deleted": True}


@api_router.get("/collections/summary")
async def collections_summary(days: int = 7, u=Depends(current_user)):
    """Workspace-wide daily totals; read-only for all authenticated users."""
    days = max(1, min(90, days))
    from datetime import datetime, timedelta
    today = datetime.utcnow().date()
    start = (today - timedelta(days=days - 1)).isoformat()
    q: dict = {"date_key": {"$gte": start}}
    docs = await db.collections.find(
        q, {"_id": 0, "date_key": 1, "cash_total": 1, "online_total": 1, "grand_total": 1},
    ).to_list(1000)
    by_day: dict = {}
    for d in docs:
        by_day.setdefault(d["date_key"], {"cash": 0.0, "online": 0.0, "total": 0.0})
        by_day[d["date_key"]]["cash"] += float(d.get("cash_total", 0))
        by_day[d["date_key"]]["online"] += float(d.get("online_total", 0))
        by_day[d["date_key"]]["total"] += float(d.get("grand_total", 0))
    days_list = []
    for i in range(days):
        d = (today - timedelta(days=days - 1 - i)).isoformat()
        agg = by_day.get(d, {"cash": 0.0, "online": 0.0, "total": 0.0})
        days_list.append({"date": d, **agg})
    totals = {
        "cash": sum(x["cash"] for x in days_list),
        "online": sum(x["online"] for x in days_list),
        "total": sum(x["total"] for x in days_list),
    }
    return {"days": days_list, "totals": totals}


# ---------- Daily Sales Cash (per employee) ----------
@api_router.post("/daily-sales", response_model=DailySale)
async def create_daily_sale(body: DailySaleBody, u=Depends(current_user)):
    """Any employee (or admin) logs their own daily sale (cash denominations + online).
    Admin may pass `user` to log it on behalf of an employee."""
    date_key = (body.date_key or today_key()).strip()
    owner = u["username"]
    if body.user and body.user != u["username"]:
        if u["role"] != "admin":
            raise HTTPException(403, "Only admin can log a cash count for someone else")
        if not await db.users.find_one({"username": body.user}, {"_id": 0}):
            raise HTTPException(400, "Unknown employee")
        owner = body.user
    denoms = _clean_denoms(body.denominations or {})
    cash_total = _cash_total_from_denoms(denoms)
    online_total = float(max(0.0, body.online_total or 0))
    grand = cash_total + online_total
    now = now_iso()
    doc = {
        "id": str(uuid.uuid4()),
        "user": owner,
        "date_key": date_key,
        "denominations": denoms,
        "cash_total": cash_total,
        "online_total": online_total,
        "grand_total": grand,
        "notes": (body.notes or "").strip(),
        "created_at": now,
        "updated_at": now,
    }
    await db.daily_sales.insert_one(doc)
    doc.pop("_id", None)
    doc["display_name"] = await _display_name_for(doc["user"])
    return DailySale(**doc)


@api_router.get("/daily-sales", response_model=List[DailySale])
async def list_daily_sales(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    user: Optional[str] = None,
    limit: int = 100,
    u=Depends(current_user),
):
    """Workspace-wide read; scope by user query param if provided (admin) or self."""
    q: dict = {}
    if from_date or to_date:
        r: dict = {}
        if from_date: r["$gte"] = from_date
        if to_date: r["$lte"] = to_date
        q["date_key"] = r
    if user:
        q["user"] = user
    limit = max(1, min(500, limit))
    docs = (
        await db.daily_sales.find(q, {"_id": 0})
        .sort([("date_key", -1), ("created_at", -1)])
        .limit(limit)
        .to_list(limit)
    )
    name_cache: dict = {}
    for d in docs:
        uname = d["user"]
        if uname not in name_cache:
            name_cache[uname] = await _display_name_for(uname)
        d["display_name"] = name_cache[uname]
    return [DailySale(**d) for d in docs]


@api_router.patch("/daily-sales/{sid}", response_model=DailySale)
async def update_daily_sale(sid: str, body: DailySaleBody, u=Depends(current_user)):
    """Owner or admin can edit."""
    doc = await db.daily_sales.find_one({"id": sid}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Entry not found")
    if u["role"] != "admin" and doc["user"] != u["username"]:
        raise HTTPException(403, "You can only edit your own entries")
    upd: dict = {}
    if body.date_key is not None:
        upd["date_key"] = body.date_key.strip()
    if body.denominations is not None:
        upd["denominations"] = _clean_denoms(body.denominations or {})
        upd["cash_total"] = _cash_total_from_denoms(upd["denominations"])
    if body.online_total is not None:
        upd["online_total"] = float(max(0.0, body.online_total))
    if body.notes is not None:
        upd["notes"] = body.notes.strip()
    if body.user and body.user != doc["user"]:
        if u["role"] != "admin":
            raise HTTPException(403, "Only admin can reassign a cash count")
        if not await db.users.find_one({"username": body.user}, {"_id": 0}):
            raise HTTPException(400, "Unknown employee")
        upd["user"] = body.user
    if not upd:
        raise HTTPException(400, "No changes")
    cash = upd.get("cash_total", doc.get("cash_total", 0))
    online = upd.get("online_total", doc.get("online_total", 0))
    upd["grand_total"] = float(cash) + float(online)
    upd["updated_at"] = now_iso()
    await db.daily_sales.update_one({"id": sid}, {"$set": upd})
    fresh = await db.daily_sales.find_one({"id": sid}, {"_id": 0})
    fresh["display_name"] = await _display_name_for(fresh["user"])
    return DailySale(**fresh)


@api_router.delete("/daily-sales/{sid}")
async def delete_daily_sale(sid: str, _=Depends(admin_only)):
    res = await db.daily_sales.delete_one({"id": sid})
    if res.deleted_count == 0:
        raise HTTPException(404, "Not found")
    return {"deleted": True}


@api_router.get("/daybook")
async def daybook(date: Optional[str] = None, _=Depends(admin_or_collector)):
    """Consolidated day-book (admin + collector only): sales, invoices, due-collection,
    money-receipts, cash verification (calculator) and cash-desk photos."""
    day = (date or today_key()).strip()
    return await _build_daybook(day)


async def _build_daybook(day: str) -> dict:
    col_docs = await db.collections.find({"date_key": day}, {"_id": 0}).sort("created_at", 1).to_list(500)
    ds_docs = await db.daily_sales.find({"date_key": day}, {"_id": 0}).sort("created_at", 1).to_list(500)
    rc_docs = await db.receipts.find({"date_key": day}, {"_id": 0}).sort("created_at", 1).to_list(500)
    inv_docs = await db.invoices.find({"date_key": day}, {"_id": 0}).sort("created_at", 1).to_list(500)
    # Manual (punched) sales for the day — invoice-generated legacy sales are excluded (counted under invoices)
    sale_raw = await db.sales.find(
        {"date_key": day, "source": {"$ne": "invoice"}}, {"_id": 0}
    ).sort("timestamp", 1).to_list(500)
    sale_docs = [sale_from_doc(d).model_dump() for d in sale_raw]

    name_cache: dict = {}
    async def _name(uname: str) -> str:
        if uname not in name_cache:
            name_cache[uname] = await _display_name_for(uname)
        return name_cache[uname]

    for d in col_docs:
        d["display_name"] = await _name(d["user"])
    for d in ds_docs:
        d["display_name"] = await _name(d["user"])
    for d in sale_docs:
        d["display_name"] = d.get("display_name") or await _name(d["user"])

    # Build receipt lookup: source_id -> [{receipt_no, amount, id, payment_mode}]
    # and split receipt totals by cash / online using explicit cash_amount/online_amount fields
    # (falling back to payment_mode for legacy records without the split).
    receipts_by_src: dict = {}
    rc_cash = 0.0
    rc_online = 0.0
    for r in rc_docs:
        # attach display + pdf token
        r["display_name"] = await _name(r["user"])
        if r.get("pdf_path"):
            r["pdf_token"] = _make_media_token(r["pdf_path"])
        # totals split — prefer explicit cash/online fields
        amt = float(r.get("amount") or 0)
        mode = (r.get("payment_mode") or "cash").lower()
        c_amt = r.get("cash_amount")
        o_amt = r.get("online_amount")
        if c_amt is None or o_amt is None:
            # Legacy: derive from mode
            if mode == "online":
                c_amt, o_amt = 0.0, amt
            elif mode == "mixed":
                c_amt, o_amt = amt, 0.0  # unknown — treat as cash
            else:
                c_amt, o_amt = amt, 0.0
        rc_cash += float(c_amt or 0)
        rc_online += float(o_amt or 0)
        sid = r.get("source_id")
        if sid:
            receipts_by_src.setdefault(sid, []).append({
                "id": r["id"],
                "receipt_no": r["receipt_no"],
                "amount": amt,
                "payment_mode": mode,
                "cash_amount": float(c_amt or 0),
                "online_amount": float(o_amt or 0),
                "reference_no": r.get("reference_no") or "",
                "source_type": (r.get("source_type") or "other").lower(),
                "pdf_token": r.get("pdf_token"),
            })

    # Enrich collection entries with linked receipts (duplicate-prevention info)
    for d in col_docs:
        d["linked_receipts"] = receipts_by_src.get(d["id"], [])

    # Enrich daily_sales entries: a user's daily sale entry links to receipts of that user for the day
    # of type "sale" or "invoice" where source is that user (heuristic: same user + same date)
    ds_receipts_by_user: dict = {}
    for r in rc_docs:
        if (r.get("source_type") or "").lower() in {"sale", "invoice"}:
            ds_receipts_by_user.setdefault(r["user"], []).append({
                "id": r["id"],
                "receipt_no": r["receipt_no"],
                "amount": float(r.get("amount") or 0),
                "payment_mode": (r.get("payment_mode") or "cash").lower(),
                "reference_no": r.get("reference_no") or "",
                "source_type": (r.get("source_type") or "other").lower(),
                "pdf_token": r.get("pdf_token"),
                "customer_name": r.get("customer_name", ""),
            })
    for d in ds_docs:
        d["linked_receipts"] = ds_receipts_by_user.get(d["user"], [])

    def _totals(docs):
        return {
            "cash": float(sum(d.get("cash_total", 0) for d in docs)),
            "online": float(sum(d.get("online_total", 0) for d in docs)),
            "total": float(sum(d.get("grand_total", 0) for d in docs)),
        }

    col_totals = _totals(col_docs)
    ds_totals = _totals(ds_docs)
    rc_totals = {"cash": rc_cash, "online": rc_online, "total": rc_cash + rc_online}

    # Invoices for the day (with cash/online split from invoice payment)
    inv_total = 0.0
    inv_cash = 0.0
    inv_online = 0.0
    # Build receipt lookup by invoice_id for duplicate detection
    inv_receipts_by_src: dict = {}
    for r in rc_docs:
        if (r.get("source_type") or "").lower() == "invoice" and r.get("source_id"):
            inv_receipts_by_src.setdefault(r["source_id"], []).append({
                "id": r["id"],
                "receipt_no": r["receipt_no"],
                "amount": float(r.get("amount") or 0),
                "payment_mode": (r.get("payment_mode") or "cash").lower(),
                "reference_no": r.get("reference_no") or "",
                "source_type": "invoice",
                "pdf_token": r.get("pdf_token"),
            })
    for iv in inv_docs:
        iv["display_name"] = await _name(iv["user"])
        if iv.get("pdf_path"):
            iv["pdf_token"] = _make_media_token(iv["pdf_path"])
        iv["linked_receipts"] = inv_receipts_by_src.get(iv["id"], [])
        total = float(iv.get("total") or 0)
        c_amt = iv.get("cash_amount")
        o_amt = iv.get("online_amount")
        if c_amt is None or o_amt is None:
            # Legacy invoices without split — derive from payment_mode (default cash)
            mode = (iv.get("payment_mode") or "cash").lower()
            if mode == "online":
                c_amt, o_amt = 0.0, total
            elif mode == "mixed":
                c_amt, o_amt = total, 0.0
            else:
                c_amt, o_amt = total, 0.0
        inv_total += total
        inv_cash += float(c_amt or 0)
        inv_online += float(o_amt or 0)
    inv_totals = {"cash": inv_cash, "online": inv_online, "total": inv_total}

    # Manual sales for the day (cash / online split is the money actually received at sale time)
    sale_cash = 0.0
    sale_online = 0.0
    for s in sale_docs:
        s["linked_receipts"] = receipts_by_src.get(s["id"], [])
        sale_cash += float(s.get("cash_amount") or 0)
        sale_online += float(s.get("online_amount") or 0)
    sale_totals = {"cash": sale_cash, "online": sale_online, "total": sale_cash + sale_online}

    # Standalone receipts = fresh money not already counted through a source listed on THIS day.
    #   - source_type='other' (advance / ad-hoc)
    #   - OR the source (sale/invoice/collection) is not among today's docs (paid later, or source deleted)
    counted_ids = {d["id"] for d in col_docs} | {iv["id"] for iv in inv_docs} | {s["id"] for s in sale_docs}
    other_rc_cash = 0.0
    other_rc_online = 0.0
    for r in rc_docs:
        sid = r.get("source_id")
        standalone = (r.get("source_type") or "other").lower() == "other" or not sid or sid not in counted_ids
        r["counted_standalone"] = standalone
        if standalone:
            amt = float(r.get("amount") or 0)
            mode = (r.get("payment_mode") or "cash").lower()
            c_amt = r.get("cash_amount")
            o_amt = r.get("online_amount")
            if c_amt is None or o_amt is None:
                if mode == "online":
                    c_amt, o_amt = 0.0, amt
                elif mode == "mixed":
                    c_amt, o_amt = amt, 0.0
                else:
                    c_amt, o_amt = amt, 0.0
            other_rc_cash += float(c_amt or 0)
            other_rc_online += float(o_amt or 0)
    standalone_rc_totals = {"cash": other_rc_cash, "online": other_rc_online, "total": other_rc_cash + other_rc_online}

    # Grand total (all real cash/online inflow for the day):
    #   - Manual sales cash & online
    #   - Invoice cash & online
    #   - Due collection cash & online
    #   - Standalone money receipts (see above) — receipts linked to a source counted
    #     today are informational (not added, to avoid double count).
    grand = {
        "cash": col_totals["cash"] + inv_cash + sale_cash + other_rc_cash,
        "online": col_totals["online"] + inv_online + sale_online + other_rc_online,
        "total": col_totals["total"] + inv_total + sale_totals["total"] + other_rc_cash + other_rc_online,
    }

    # Cash verification (calculator): the admin/collector counts the physical cash by
    # denomination and saves ONE verification per day. Compared with expected cash =
    # sales cash + invoice cash + due-collection cash + standalone receipts cash.
    expected_cash = float(sale_cash + inv_cash + col_totals["cash"] + other_rc_cash)
    cv = await db.cash_verifications.find_one({"date_key": day}, {"_id": 0})
    if cv:
        cv["verified_by_name"] = await _name(cv.get("verified_by", "")) if cv.get("verified_by") else ""
    counted_cash = float(cv["cash_total"]) if cv else None
    variance = (counted_cash - expected_cash) if counted_cash is not None else None
    ack = await db.reconciliation.find_one({"date_key": day}, {"_id": 0})
    reconciliation = {
        "verified": cv is not None,
        "match": (abs(variance) < 0.01) if variance is not None else False,
        "expected_cash": expected_cash,
        "counted_cash": counted_cash,
        "variance_total": variance if variance is not None else 0.0,
        "denominations": (cv or {}).get("denominations") or {},
        "note": (cv or {}).get("note") or "",
        "verified_by": (cv or {}).get("verified_by"),
        "verified_by_name": (cv or {}).get("verified_by_name"),
        "verified_at": (cv or {}).get("verified_at"),
        "acknowledgement": ack.get("acknowledgement") if ack else None,
        "acknowledged_by": ack.get("acknowledged_by") if ack else None,
        "acknowledged_at": ack.get("acknowledged_at") if ack else None,
    }

    # Cash-desk photos captured for the day (cash bundle, counter, register …)
    photos = await db.daybook_photos.find({"date_key": day}, {"_id": 0}).sort("created_at", 1).to_list(50)
    for p in photos:
        p["token"] = _make_media_token(p["path"])
        p["display_name"] = await _name(p["user"])

    # Total collection breakdown (as user requested): show all 4 components
    total_collection = {
        "daily_sales": ds_totals["total"],
        "cash_in_hand": counted_cash,
        "sales": sale_totals["total"],
        "invoices": inv_totals["total"],
        "due_collection": col_totals["total"],
        "money_receipts": rc_totals["total"],
        "standalone_receipts": standalone_rc_totals["total"],
        "grand_total": grand["total"],  # avoids double counting
    }

    return {
        "date": day,
        "due_collection": {**col_totals, "entries": col_docs},
        "daily_sales": {**ds_totals, "entries": ds_docs},
        "sales": {**sale_totals, "entries": sale_docs},
        "receipts": {**rc_totals, "entries": rc_docs},
        "standalone_receipts": standalone_rc_totals,
        "invoices": {**inv_totals, "entries": inv_docs},
        "grand_total": grand,
        "reconciliation": reconciliation,
        "expected_cash": expected_cash,
        "cash_verification": cv,
        "photos": photos,
        "total_collection": total_collection,
    }


class CashVerificationBody(BaseModel):
    date_key: Optional[str] = None
    denominations: dict = Field(default_factory=dict)
    note: Optional[str] = ""


@api_router.put("/daybook/cash-verification")
async def save_cash_verification(body: CashVerificationBody, u=Depends(admin_or_collector)):
    """Cash calculator: save the physical denomination count for a day (one record per date)."""
    day = (body.date_key or today_key()).strip()
    denoms = _clean_denoms(body.denominations or {})
    cash_total = _cash_total_from_denoms(denoms)
    now = now_iso()
    existing = await db.cash_verifications.find_one({"date_key": day}, {"_id": 0})
    doc = {
        "id": existing["id"] if existing else str(uuid.uuid4()),
        "date_key": day,
        "denominations": denoms,
        "cash_total": cash_total,
        "note": (body.note or "").strip(),
        "verified_by": u["username"],
        "verified_at": now,
        "created_at": existing["created_at"] if existing else now,
    }
    await db.cash_verifications.update_one({"date_key": day}, {"$set": doc}, upsert=True)
    return await _build_daybook(day)


@api_router.delete("/daybook/cash-verification")
async def clear_cash_verification(date: str = Query(...), _=Depends(admin_only)):
    await db.cash_verifications.delete_one({"date_key": date})
    return {"deleted": True}


class DaybookPhotoBody(BaseModel):
    date_key: Optional[str] = None
    path: str
    caption: Optional[str] = ""


@api_router.post("/daybook/photos")
async def add_daybook_photo(body: DaybookPhotoBody, u=Depends(admin_or_collector)):
    """Attach a captured image (cash bundle / counter) to the day's daybook."""
    if not body.path or not body.path.startswith(f"{APP_NAME}/"):
        raise HTTPException(400, "Invalid image path")
    doc = {
        "id": str(uuid.uuid4()),
        "date_key": (body.date_key or today_key()).strip(),
        "path": body.path,
        "caption": (body.caption or "").strip(),
        "user": u["username"],
        "created_at": now_iso(),
    }
    await db.daybook_photos.insert_one(doc)
    doc.pop("_id", None)
    doc["token"] = _make_media_token(doc["path"])
    doc["display_name"] = await _display_name_for(u["username"])
    return doc


@api_router.delete("/daybook/photos/{pid}")
async def delete_daybook_photo(pid: str, u=Depends(admin_or_collector)):
    doc = await db.daybook_photos.find_one({"id": pid}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Not found")
    if u["role"] != "admin" and doc["user"] != u["username"]:
        raise HTTPException(403, "You can only delete your own photos")
    await db.daybook_photos.delete_one({"id": pid})
    return {"deleted": True}



class ReconcileAckBody(BaseModel):
    date_key: str
    acknowledgement: str  # note explaining the variance


@api_router.post("/daybook/reconcile-ack")
async def acknowledge_reconciliation(body: ReconcileAckBody, u=Depends(admin_only)):
    """Admin acknowledges a denomination variance for a specific day with a note."""
    date_key = (body.date_key or "").strip()
    if not date_key:
        raise HTTPException(400, "date_key is required")
    note = (body.acknowledgement or "").strip()
    if not note:
        raise HTTPException(400, "acknowledgement note is required")
    now = now_iso()
    await db.reconciliation.update_one(
        {"date_key": date_key},
        {"$set": {
            "date_key": date_key,
            "acknowledgement": note,
            "acknowledged_by": u["username"],
            "acknowledged_at": now,
        }},
        upsert=True,
    )
    return {"ok": True, "acknowledged_at": now}


# ---------- Daybook Excel export ----------
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _date_range(from_date: str, to_date: str) -> List[str]:
    a = datetime.strptime(from_date, "%Y-%m-%d").date()
    b = datetime.strptime(to_date, "%Y-%m-%d").date()
    if b < a:
        a, b = b, a
    if (b - a).days > 62:
        raise HTTPException(400, "Range too large (max 62 days)")
    return [(a + timedelta(days=i)).isoformat() for i in range((b - a).days + 1)]


@api_router.get("/daybook/export-token")
async def daybook_export_token(
    from_date: str = Query(..., alias="from"),
    to_date: Optional[str] = Query(None, alias="to"),
    u=Depends(current_user),
):
    """Short-lived token so the device browser can download the .xlsx without a bearer header.
    Access: admin or the assigned collector."""
    collector = await _current_collector_username()
    if u["role"] != "admin" and u["username"] != collector:
        raise HTTPException(403, "Only admin or the assigned collector can export the daybook")
    to_date = to_date or from_date
    if not DATE_RE.match(from_date) or not DATE_RE.match(to_date):
        raise HTTPException(400, "Dates must be YYYY-MM-DD")
    _date_range(from_date, to_date)  # validates
    payload = {
        "kind": "report:daybook", "from": from_date, "to": to_date, "sub": u["username"],
        "exp": datetime.now(timezone.utc) + timedelta(minutes=10),
    }
    return {"token": jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)}


def _rc_split(r: dict) -> tuple:
    amt = float(r.get("amount") or 0)
    mode = (r.get("payment_mode") or "cash").lower()
    c, o = r.get("cash_amount"), r.get("online_amount")
    if c is None or o is None:
        if mode == "online":
            return 0.0, amt
        return amt, 0.0
    return float(c or 0), float(o or 0)


@api_router.get("/daybook.xlsx")
async def daybook_xlsx(token: str = Query(...)):
    try:
        data = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid or expired token")
    if data.get("kind") != "report:daybook":
        raise HTTPException(401, "Wrong report token")
    days = _date_range(data["from"], data["to"])
    from openpyxl.styles import Font, PatternFill, Alignment

    bold = Font(bold=True)
    head_fill = PatternFill("solid", fgColor="FDE7D3")
    title_font = Font(bold=True, size=13, color="C2410C")
    money = "#,##0.00"

    def _head(ws, row):
        ws.append(row)
        for cell in ws[ws.max_row]:
            cell.font = bold
            cell.fill = head_fill
            cell.alignment = Alignment(horizontal="center")

    def _widths(ws, widths):
        for i, w in enumerate(widths):
            ws.column_dimensions[chr(ord("A") + i)].width = w

    def _money(ws, cols, start_row=2):
        for c in cols:
            for cell in ws[c][start_row - 1:]:
                cell.number_format = money

    wb = Workbook()
    ws_sum = wb.active
    ws_sum.title = "Summary"
    ws_sales = wb.create_sheet("Sales")
    ws_inv = wb.create_sheet("Invoices")
    ws_col = wb.create_sheet("Due Collection")
    ws_rc = wb.create_sheet("Money Receipts")
    ws_cash = wb.create_sheet("Cash Count")

    title = f"Daybook — {days[0]}" if len(days) == 1 else f"Daybook — {days[0]} to {days[-1]}"
    ws_sum.append([title])
    ws_sum["A1"].font = title_font
    ws_sum.append([f"Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}"])
    ws_sum.append([])
    _head(ws_sum, [
        "Date", "Grand Total", "Grand Cash", "Grand Online",
        "Sales Total", "Sales Cash", "Sales Online",
        "Invoices Total", "Invoices Cash", "Invoices Online",
        "Due Collection Total", "Due Coll. Cash", "Due Coll. Online",
        "Standalone Receipts Total", "Standalone Cash", "Standalone Online",
        "All Receipts Total (info)",
        "Counted Cash (calculator)", "Expected Cash", "Variance", "Reconciled", "Note",
    ])

    _head(ws_sales, ["Date", "Time", "Employee", "Customer", "Product", "Amount", "Cash", "Online", "Mode", "Receipts", "Notes"])
    _head(ws_inv, ["Date", "Invoice No", "Employee", "Customer", "Mobile", "Items", "Total", "Cash", "Online", "Mode", "Receipts", "Notes"])
    _head(ws_col, ["Date", "Collector", "Cash", "Online", "Total", "Receipts", "Notes"])
    _head(ws_rc, ["Date", "Receipt No", "Employee", "Customer", "Mobile", "Amount", "Cash", "Online", "Mode", "For", "Reference", "Source", "Counted in total?", "Narration"])
    _head(ws_cash, ["Date", "Verified by", "Verified at"] + [f"₹{d} pcs" for d in DENOMS] + ["Counted Cash", "Expected Cash", "Variance", "Note", "Photos"])

    range_tot = {"grand": 0.0, "cash": 0.0, "online": 0.0}
    for day in days:
        d = await _build_daybook(day)
        g = d["grand_total"]
        rec = d["reconciliation"]
        ss, iv, cl, rc, sa = d["sales"], d["invoices"], d["due_collection"], d["receipts"], d["standalone_receipts"]
        expected_cash = float(d.get("expected_cash") or 0)
        counted = rec.get("counted_cash")
        variance = (float(counted) - expected_cash) if counted is not None else None
        ws_sum.append([
            day, g["total"], g["cash"], g["online"],
            ss["total"], ss["cash"], ss["online"],
            iv["total"], iv["cash"], iv["online"],
            cl["total"], cl["cash"], cl["online"],
            sa["total"], sa["cash"], sa["online"],
            rc["total"],
            counted if counted is not None else "", expected_cash, variance if variance is not None else "",
            ("Yes" if abs(variance) < 0.01 else ("Acknowledged" if rec.get("acknowledgement") else "No")) if variance is not None else "Not verified",
            (rec.get("note") or "") + ((" | " + rec["acknowledgement"]) if rec.get("acknowledgement") else ""),
        ])
        range_tot["grand"] += g["total"]; range_tot["cash"] += g["cash"]; range_tot["online"] += g["online"]

        for s in ss["entries"]:
            ts = s.get("timestamp") or ""
            ws_sales.append([
                day, ts.split("T")[1][:8] if "T" in ts else "",
                s.get("display_name") or s.get("user", ""), s.get("customer_name", ""), s.get("product", ""),
                float(s.get("amount") or 0), float(s.get("cash_amount") or 0), float(s.get("online_amount") or 0),
                (s.get("payment_mode") or "cash").upper(),
                ", ".join(r["receipt_no"] for r in s.get("linked_receipts") or []),
                s.get("notes", ""),
            ])
        for i in iv["entries"]:
            c_amt, o_amt = _rc_split({"amount": i.get("total"), "payment_mode": i.get("payment_mode"), "cash_amount": i.get("cash_amount"), "online_amount": i.get("online_amount")})
            ws_inv.append([
                day, i.get("invoice_no", ""), i.get("display_name") or i.get("user", ""),
                i.get("customer_name", ""), i.get("customer_mobile", ""), len(i.get("items") or []),
                float(i.get("total") or 0), c_amt, o_amt, (i.get("payment_mode") or "cash").upper(),
                ", ".join(r["receipt_no"] for r in i.get("linked_receipts") or []),
                i.get("notes", ""),
            ])
        for c in cl["entries"]:
            ws_col.append([
                day, c.get("display_name") or c.get("user", ""),
                float(c.get("cash_total") or 0), float(c.get("online_total") or 0), float(c.get("grand_total") or 0),
                ", ".join(r["receipt_no"] for r in c.get("linked_receipts") or []),
                c.get("notes", ""),
            ])
        for r in rc["entries"]:
            c_amt, o_amt = _rc_split(r)
            ws_rc.append([
                day, r.get("receipt_no", ""), r.get("display_name") or r.get("user", ""),
                r.get("customer_name", ""), r.get("customer_mobile", ""),
                float(r.get("amount") or 0), c_amt, o_amt, (r.get("payment_mode") or "cash").upper(),
                (r.get("source_type") or "other").title(), r.get("reference_no") or "", r.get("source_label") or "",
                "Counted" if r.get("counted_standalone") else "Linked (info only)",
                r.get("narration") or r.get("notes") or "",
            ])
        if rec.get("verified"):
            den = rec.get("denominations") or {}
            ws_cash.append([
                day, rec.get("verified_by_name") or rec.get("verified_by") or "", (rec.get("verified_at") or "")[:19].replace("T", " "),
                *[int(den.get(str(dn), 0) or 0) for dn in DENOMS],
                float(counted or 0), expected_cash, float(variance or 0),
                rec.get("note") or "", len(d.get("photos") or []),
            ])

    if len(days) > 1:
        ws_sum.append([])
        ws_sum.append(["TOTAL", range_tot["grand"], range_tot["cash"], range_tot["online"]])
        for cell in ws_sum[ws_sum.max_row]:
            cell.font = bold

    _money(ws_sum, "BCDEFGHIJKLMNOPQRST", start_row=5)
    _widths(ws_sum, [12] + [14] * 19 + [12, 40])
    _money(ws_sales, "FGH"); _widths(ws_sales, [12, 10, 16, 22, 20, 12, 12, 12, 8, 24, 36])
    _money(ws_inv, "GHI"); _widths(ws_inv, [12, 14, 16, 22, 14, 7, 12, 12, 12, 8, 24, 36])
    _money(ws_col, "CDE"); _widths(ws_col, [12, 16, 12, 12, 12, 24, 40])
    _money(ws_rc, "FGH"); _widths(ws_rc, [12, 14, 16, 22, 14, 12, 12, 12, 8, 12, 14, 24, 18, 36])
    n_den = len(DENOMS)
    _money(ws_cash, [chr(ord("D") + n_den + k) for k in range(3)])
    _widths(ws_cash, [12, 16, 18] + [9] * n_den + [14, 14, 12, 36, 8])
    for ws in (ws_sum, ws_sales, ws_inv, ws_col, ws_rc, ws_cash):
        ws.freeze_panes = "A5" if ws is ws_sum else "A2"

    fname = f"daybook_{days[0]}.xlsx" if len(days) == 1 else f"daybook_{days[0]}_to_{days[-1]}.xlsx"
    return _xlsx_response(wb, fname)


# ---------- Full data backup (admin) ----------
BACKUP_COLLECTIONS = [
    "users", "settings", "customers", "sales", "invoices", "receipts", "collections",
    "cash_verifications", "daybook_photos", "reconciliation", "daily_sales",
    "attendance", "expenses", "call_logs", "followups", "counters",
]


@api_router.get("/admin/backup/token")
async def backup_token(u=Depends(admin_only)):
    payload = {"kind": "report:backup", "sub": u["username"], "exp": datetime.now(timezone.utc) + timedelta(minutes=10)}
    return {"token": jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)}


def _check_backup_token(token: str) -> None:
    try:
        data = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid or expired token")
    if data.get("kind") != "report:backup":
        raise HTTPException(401, "Wrong token")


async def _collect_backup() -> dict:
    existing = set(await db.list_collection_names())
    out: dict = {}
    for name in BACKUP_COLLECTIONS:
        if name not in existing:
            out[name] = []
            continue
        docs = await db[name].find({}, {"_id": 0}).to_list(100000)
        out[name] = docs
    # Any other app collections not in the fixed list
    for name in sorted(existing):
        if name in out or name.startswith("system."):
            continue
        out[name] = await db[name].find({}, {"_id": 0}).to_list(100000)
    return out


@api_router.get("/admin/backup.json")
async def backup_json(token: str = Query(...)):
    """Restore-ready copy: every collection as JSON (includes user password hashes — keep it private)."""
    _check_backup_token(token)
    data = await _collect_backup()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M")
    payload = {
        "app": APP_NAME, "exported_at": now_iso(), "db": os.environ.get("DB_NAME", ""),
        "counts": {k: len(v) for k, v in data.items()},
        "collections": data,
    }
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    return Response(
        content=body, media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="backup_{stamp}.json"'},
    )


@api_router.get("/admin/backup.xlsx")
async def backup_xlsx(token: str = Query(...)):
    """Human-readable backup: one sheet per collection, nested values as JSON text."""
    _check_backup_token(token)
    data = await _collect_backup()
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter
    bold = Font(bold=True)
    fill = PatternFill("solid", fgColor="FDE7D3")
    wb = Workbook()
    ws0 = wb.active
    ws0.title = "Index"
    ws0.append(["Collection", "Records"])
    for c in ws0[1]:
        c.font = bold; c.fill = fill
    ws0.append([f"Exported {now_iso()}", ""])
    for name, docs in data.items():
        ws0.append([name, len(docs)])
        ws = wb.create_sheet(name[:31])
        # Column set = union of keys, preserving first-seen order
        cols: List[str] = []
        seen = set()
        for d in docs:
            for k in d.keys():
                if k == "password_hash":
                    continue
                if k not in seen:
                    seen.add(k); cols.append(k)
        if not cols:
            ws.append(["(empty)"])
            continue
        ws.append(cols)
        for c in ws[1]:
            c.font = bold; c.fill = fill
        for d in docs:
            row = []
            for k in cols:
                v = d.get(k)
                if isinstance(v, (dict, list)):
                    v = json.dumps(v, ensure_ascii=False, default=str)
                elif v is not None and not isinstance(v, (str, int, float, bool)):
                    v = str(v)
                if isinstance(v, str) and len(v) > 32000:
                    v = v[:32000] + "…"
                row.append(v)
            ws.append(row)
        for i, k in enumerate(cols, start=1):
            ws.column_dimensions[get_column_letter(i)].width = min(48, max(12, len(k) + 4))
        ws.freeze_panes = "A2"
    ws0.column_dimensions["A"].width = 26
    ws0.column_dimensions["B"].width = 12
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M")
    return _xlsx_response(wb, f"backup_{stamp}.xlsx")




# ---------- Attendance ----------
class AttendanceBody(BaseModel):
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    accuracy: Optional[float] = None
    address: Optional[str] = None
    selfie_path: Optional[str] = None


@api_router.post("/attendance/check-in")
async def check_in(body: AttendanceBody, u=Depends(current_user)):
    day = today_key()
    existing = await db.attendance.find_one({"user": u["username"], "date_key": day}, {"_id": 0})
    if existing:
        return existing
    doc = {
        "id": str(uuid.uuid4()),
        "user": u["username"],
        "display_name": u.get("display_name", u["username"]),
        "date_key": day,
        "check_in": now_iso(),
        "check_in_location": {
            "latitude": body.latitude,
            "longitude": body.longitude,
            "accuracy": body.accuracy,
            "address": body.address,
        } if body.latitude is not None else None,
        "check_in_selfie": body.selfie_path,
        "check_out": None,
        "check_out_location": None,
        "check_out_selfie": None,
    }
    await db.attendance.insert_one(doc)
    doc.pop("_id", None)
    return doc

@api_router.post("/attendance/check-out")
async def check_out(body: AttendanceBody, u=Depends(current_user)):
    day = today_key()
    doc = await db.attendance.find_one_and_update(
        {"user": u["username"], "date_key": day},
        {"$set": {
            "check_out": now_iso(),
            "check_out_location": {
                "latitude": body.latitude,
                "longitude": body.longitude,
                "accuracy": body.accuracy,
                "address": body.address,
            } if body.latitude is not None else None,
            "check_out_selfie": body.selfie_path,
        }},
        return_document=True,
        projection={"_id": 0},
    )
    if not doc:
        raise HTTPException(400, "You haven't checked in today")
    return doc

@api_router.get("/attendance/today")
async def attendance_today(u=Depends(current_user)):
    day = today_key()
    if u["role"] == "admin":
        docs = await db.attendance.find({"date_key": day}, {"_id": 0}).sort("check_in", 1).to_list(50)
        return {"today": day, "records": docs}
    doc = await db.attendance.find_one({"user": u["username"], "date_key": day}, {"_id": 0})
    return {"today": day, "records": [doc] if doc else []}


@api_router.post("/attendance/break-start")
async def break_start(u=Depends(current_user)):
    day = today_key()
    doc = await db.attendance.find_one({"user": u["username"], "date_key": day}, {"_id": 0})
    if not doc:
        raise HTTPException(400, "Check in first")
    if doc.get("check_out"):
        raise HTTPException(400, "Already checked out")
    breaks = doc.get("breaks") or []
    if breaks and breaks[-1].get("end") is None:
        return doc  # already on break, idempotent
    breaks.append({"start": now_iso(), "end": None})
    updated = await db.attendance.find_one_and_update(
        {"user": u["username"], "date_key": day},
        {"$set": {"breaks": breaks}},
        return_document=True,
        projection={"_id": 0},
    )
    return updated


@api_router.post("/attendance/break-end")
async def break_end(u=Depends(current_user)):
    day = today_key()
    doc = await db.attendance.find_one({"user": u["username"], "date_key": day}, {"_id": 0})
    if not doc:
        raise HTTPException(400, "No attendance record")
    breaks = doc.get("breaks") or []
    if not breaks or breaks[-1].get("end") is not None:
        raise HTTPException(400, "No open break")
    breaks[-1]["end"] = now_iso()
    updated = await db.attendance.find_one_and_update(
        {"user": u["username"], "date_key": day},
        {"$set": {"breaks": breaks}},
        return_document=True,
        projection={"_id": 0},
    )
    return updated


@api_router.get("/attendance/history")
async def attendance_history(u=Depends(current_user), days: int = 30):
    query = {}
    if u["role"] != "admin":
        query["user"] = u["username"]
    docs = await db.attendance.find(query, {"_id": 0}).sort("date_key", -1).limit(days * 10).to_list(days * 10)
    return {"records": docs}

# ---------- Push (existing) ----------
@api_router.post("/register-push", status_code=201)
async def register_push(body: RegisterPushBody):
    await db.push_users.update_one(
        {"user_id": body.user_id},
        {"$set": {
            "user_id": body.user_id,
            "platform": body.platform,
            "device_token": body.device_token,
            "updated_at": now_iso(),
        }},
        upsert=True,
    )
    resp = await _push_client.post("/api/v1/push/users/register", json=body.model_dump())
    if resp.status_code == 401:
        raise HTTPException(500, "EMERGENT_PUSH_KEY missing or invalid")
    if resp.status_code >= 500:
        raise HTTPException(502, "Push provider unavailable")
    resp.raise_for_status()
    return {"status": "registered"}

@api_router.post("/push/test")
async def push_test(u=Depends(current_user)):
    await _notify_user(u["username"], "Pritha Cabinet test", "Push notifications are working 🎯", extra={"action_url": "/(tabs)"}, idem=f"test-{u['username']}-{datetime.now(timezone.utc).timestamp()}")
    return {"sent": True}


# ---------- Sales ----------
def sale_from_doc(doc: dict) -> Sale:
    amount = float(doc.get("amount", 0) or 0)
    purchase = doc.get("purchase_amount")
    profit = amount - float(purchase or 0)
    cash_amt = doc.get("cash_amount")
    online_amt = doc.get("online_amount")
    mode = (doc.get("payment_mode") or "").lower()
    # Legacy backfill
    if cash_amt is None or online_amt is None:
        if mode == "online":
            cash_amt, online_amt = 0.0, amount
        elif mode == "mixed":
            cash_amt, online_amt = float(cash_amt or 0), float(online_amt or 0)
            if cash_amt + online_amt < 0.01:
                cash_amt, online_amt = amount, 0.0
        else:
            cash_amt, online_amt = amount, 0.0
    if not mode:
        if float(cash_amt or 0) > 0 and float(online_amt or 0) > 0:
            mode = "mixed"
        elif float(online_amt or 0) > 0:
            mode = "online"
        else:
            mode = "cash"
    return Sale(
        id=doc["id"],
        user=doc["user"],
        display_name=doc.get("display_name"),
        customer_id=doc.get("customer_id"),
        customer_name=doc.get("customer_name", "") or "",
        amount=amount,
        cash_amount=float(cash_amt or 0),
        online_amount=float(online_amt or 0),
        payment_mode=mode,
        purchase_amount=float(purchase) if purchase is not None else None,
        profit=profit,
        currency=doc.get("currency", "INR"),
        product=doc.get("product", "") or "",
        notes=doc.get("notes", "") or "",
        date_key=doc["date_key"],
        timestamp=doc["timestamp"],
        source=doc.get("source", "manual"),
        invoice_id=doc.get("invoice_id"),
        invoice_no=doc.get("invoice_no"),
    )


def _split_payment(amount: float, cash: Optional[float], online: Optional[float], mode: Optional[str]) -> tuple:
    """Compute (cash, online, mode) from partial inputs. Validates cash+online == amount."""
    amount = float(amount or 0)
    if cash is None and online is None:
        # Fall back to mode or default cash
        m = (mode or "cash").lower()
        if m == "online":
            return 0.0, amount, "online"
        if m == "mixed":
            raise HTTPException(400, "Mixed mode requires cash_amount and online_amount")
        return amount, 0.0, "cash"
    cash = 0.0 if cash is None else float(cash)
    online = 0.0 if online is None else float(online)
    if cash < 0 or online < 0:
        raise HTTPException(400, "Cash and online amounts must be >= 0")
    if amount > 0 and abs((cash + online) - amount) > 0.01:
        # If amount doesn't match, prefer computed sum
        if cash + online > 0:
            amount = round(cash + online, 2)
    if cash > 0 and online > 0:
        m = "mixed"
    elif online > 0:
        m = "online"
    else:
        m = "cash"
    return cash, online, m


@api_router.post("/sales", response_model=Sale)
async def create_sale(body: SaleBody, u=Depends(current_user)):
    if body.amount < 0:
        raise HTTPException(400, "Amount must be >= 0")

    if body.customer_id:
        cust_q: dict = {"id": body.customer_id}
        if u["role"] != "admin":
            cust_q["assigned_to"] = u["username"]
        cust = await db.customers.find_one(cust_q, {"_id": 0})
        if not cust:
            raise HTTPException(404, "Customer not found or not yours")
        cust_name = cust.get("name", body.customer_name or "")
    else:
        cust_name = body.customer_name or ""

    cash_amt, online_amt, mode = _split_payment(body.amount, body.cash_amount, body.online_amount, body.payment_mode)
    total = cash_amt + online_amt if (body.cash_amount is not None or body.online_amount is not None) else float(body.amount)

    doc = {
        "id": str(uuid.uuid4()),
        "user": u["username"],
        "display_name": u.get("display_name", u["username"]),
        "customer_id": body.customer_id,
        "customer_name": cust_name,
        "amount": total,
        "cash_amount": cash_amt,
        "online_amount": online_amt,
        "payment_mode": mode,
        "purchase_amount": None,
        "currency": body.currency or "INR",
        "product": body.product or "",
        "notes": body.notes or "",
        "date_key": today_key(),
        "timestamp": now_iso(),
    }
    await db.sales.insert_one(doc)
    doc.pop("_id", None)

    await _notify_user(
        u["username"],
        "💰 Sale logged",
        f"₹{doc['amount']:.0f} — {cust_name or 'Customer'} · {doc['product'] or 'sale'}",
        extra={"action_url": "/sales"},
        idem=f"sale-{doc['id']}",
    )
    return sale_from_doc(doc)


@api_router.get("/sales", response_model=List[Sale])
async def list_sales(u=Depends(current_user), scope: str = "all", days: int = 30):
    """Workspace-wide by default: every employee can see every sale. scope=mine narrows to own."""
    query: dict = {}
    if scope == "mine":
        query["user"] = u["username"]
    docs = await db.sales.find(query, {"_id": 0}).sort("timestamp", -1).limit(days * 50).to_list(days * 50)
    sales = [sale_from_doc(d) for d in docs]
    # Attach linked receipts (source_type='sale' & source_id=sale.id) for duplicate-prevention badges
    ids = [s.id for s in sales]
    if ids:
        rc_cursor = db.receipts.find(
            {"source_type": "sale", "source_id": {"$in": ids}},
            {"_id": 0, "id": 1, "receipt_no": 1, "source_id": 1, "amount": 1, "payment_mode": 1, "pdf_path": 1, "reference_no": 1},
        )
        by_src: dict = {}
        async for r in rc_cursor:
            by_src.setdefault(r["source_id"], []).append({
                "id": r["id"],
                "receipt_no": r["receipt_no"],
                "amount": float(r.get("amount") or 0),
                "payment_mode": (r.get("payment_mode") or "cash").lower(),
                "reference_no": r.get("reference_no") or "",
                "pdf_token": _make_media_token(r["pdf_path"]) if r.get("pdf_path") else None,
            })
        for s in sales:
            s.linked_receipts = by_src.get(s.id, [])
    return sales


@api_router.patch("/sales/{sid}", response_model=Sale)
async def patch_sale(sid: str, body: SalePatchBody, u=Depends(current_user)):
    # Find first, then authorize
    existing = await db.sales.find_one({"id": sid}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Sale not found")
    is_admin = u["role"] == "admin"
    is_owner = existing.get("user") == u["username"]
    if not (is_admin or is_owner):
        raise HTTPException(403, "You can only edit your own sales")

    upd: dict = {}
    if body.amount is not None:
        if body.amount < 0:
            raise HTTPException(400, "amount must be >= 0")
        upd["amount"] = float(body.amount)
    if body.purchase_amount is not None:
        if not is_admin:
            raise HTTPException(403, "Only admin can set purchase amount")
        if body.purchase_amount < 0:
            raise HTTPException(400, "purchase_amount must be >= 0")
        upd["purchase_amount"] = float(body.purchase_amount)
    if body.product is not None:
        upd["product"] = body.product
    if body.notes is not None:
        upd["notes"] = body.notes
    if body.customer_name is not None:
        upd["customer_name"] = body.customer_name.strip()
    if body.customer_id is not None:
        upd["customer_id"] = body.customer_id or None
    if body.date_key is not None:
        if not is_admin:
            raise HTTPException(403, "Only admin can change the sale date")
        if not DATE_RE.match(body.date_key.strip()):
            raise HTTPException(400, "date_key must be YYYY-MM-DD")
        upd["date_key"] = body.date_key.strip()
    # Cash / online split — keep amount == cash + online
    if body.cash_amount is not None or body.online_amount is not None:
        cash = float(body.cash_amount if body.cash_amount is not None else existing.get("cash_amount") or 0)
        online = float(body.online_amount if body.online_amount is not None else existing.get("online_amount") or 0)
        if cash < 0 or online < 0:
            raise HTTPException(400, "Cash and online amounts must be >= 0")
        upd["cash_amount"] = cash
        upd["online_amount"] = online
        upd["amount"] = round(cash + online, 2)
        upd["payment_mode"] = "mixed" if (cash > 0 and online > 0) else ("online" if online > 0 else "cash")
    elif "amount" in upd:
        # Amount changed without an explicit split → keep the existing mode, rescale single-mode sales
        mode = (existing.get("payment_mode") or "cash").lower()
        if mode == "online":
            upd["cash_amount"], upd["online_amount"] = 0.0, upd["amount"]
        elif mode == "cash":
            upd["cash_amount"], upd["online_amount"] = upd["amount"], 0.0
    if not upd:
        raise HTTPException(400, "No changes")
    upd["updated_at"] = now_iso()
    upd["updated_by"] = u["username"]
    doc = await db.sales.find_one_and_update(
        {"id": sid}, {"$set": upd}, return_document=True, projection={"_id": 0},
    )
    if not doc:
        raise HTTPException(404, "Sale not found")
    return sale_from_doc(doc)


@api_router.delete("/sales/{sid}")
async def delete_sale(sid: str, _=Depends(admin_only)):
    """Only admin can remove sales (across the entire team)."""
    res = await db.sales.delete_one({"id": sid})
    if res.deleted_count == 0:
        raise HTTPException(404, "Not found")
    return {"deleted": True}


@api_router.get("/stats/sales-today")
async def sales_today(u=Depends(current_user), scope: Optional[str] = None):
    """scope=all → whole workspace; scope=mine → own only. Default: admin=all, employee=mine."""
    day = today_key()
    match: dict = {"date_key": day}
    sc = (scope or ("all" if u["role"] == "admin" else "mine")).lower()
    if sc == "mine":
        match["user"] = u["username"]
    pipeline = [
        {"$match": match},
        {"$group": {
            "_id": "$user",
            "count": {"$sum": 1},
            "revenue": {"$sum": "$amount"},
            "purchase": {"$sum": {"$ifNull": ["$purchase_amount", 0]}},
        }},
    ]
    agg = await db.sales.aggregate(pipeline).to_list(50)
    total = sum(r["count"] for r in agg)
    revenue = sum(r["revenue"] for r in agg)
    purchase = sum(r["purchase"] for r in agg)

    # split by source (manual vs invoice)
    src_pipeline = [
        {"$match": match},
        {"$group": {
            "_id": {"$ifNull": ["$source", "manual"]},
            "count": {"$sum": 1},
            "revenue": {"$sum": "$amount"},
        }},
    ]
    src_agg = await db.sales.aggregate(src_pipeline).to_list(20)
    by_source = {r["_id"]: {"count": r["count"], "revenue": r["revenue"]} for r in src_agg}
    return {
        "date": day,
        "count": total,
        "revenue": revenue,
        "purchase": purchase,
        "profit": revenue - purchase,
        "by_user": agg,
        "by_source": by_source,
    }


# ---------- Invoices & Money Receipts (PDF) ----------
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors as _colors
from reportlab.lib.units import cm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from io import BytesIO


async def _next_doc_number(kind: str) -> str:
    """kind = 'invoice' | 'receipt'. Returns zero-padded sequence like INV-000123."""
    prefix = "INV" if kind == "invoice" else "RCPT"
    counter = await db.doc_counters.find_one_and_update(
        {"_id": kind},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=True,
    )
    seq = counter["seq"] if counter else 1
    return f"{prefix}-{seq:06d}"


def _rupees(n: float) -> str:
    try:
        return "₹" + f"{float(n):,.2f}"
    except Exception:
        return f"₹{n}"


async def _build_document_pdf(
    doc_kind: str, doc_no: str, generated_by: str, date_key: str,
    customer_name: str, customer_mobile: str, customer_address: str,
    items_rows: List[List[str]], grand_total: float,
    footer_notes: str = "", narration: str = "",
) -> bytes:
    """Render a shared invoice/receipt PDF."""
    settings = await get_settings_doc()
    company_name = settings.get("company_name") or "Pritha Cabinet"
    company_addr = settings.get("company_address") or ""
    company_gstin = settings.get("company_gstin") or ""
    company_phone = settings.get("company_phone") or ""

    buf = BytesIO()
    pdf = SimpleDocTemplate(buf, pagesize=A4, topMargin=1.3*cm, bottomMargin=1*cm, leftMargin=1.3*cm, rightMargin=1.3*cm)
    styles = getSampleStyleSheet()
    h_style = ParagraphStyle("h", parent=styles["Title"], fontSize=22, spaceAfter=2, textColor=_colors.HexColor("#B45309"))
    sub_style = ParagraphStyle("sub", parent=styles["Normal"], fontSize=9, textColor=_colors.HexColor("#6B7280"))
    lbl_style = ParagraphStyle("lbl", parent=styles["Normal"], fontSize=9, textColor=_colors.HexColor("#6B7280"))
    body_style = ParagraphStyle("body", parent=styles["Normal"], fontSize=11)
    doc_title = "INVOICE" if doc_kind == "invoice" else "MONEY RECEIPT"

    story = []
    story.append(Paragraph(company_name, h_style))
    meta_parts = []
    if company_addr: meta_parts.append(company_addr)
    if company_phone: meta_parts.append("Ph: " + company_phone)
    if company_gstin: meta_parts.append("GSTIN: " + company_gstin)
    story.append(Paragraph(" · ".join(meta_parts), sub_style))
    story.append(Spacer(1, 8))

    # Doc title + no + date
    title_table = Table([[
        Paragraph(f"<b>{doc_title}</b>", ParagraphStyle("t", parent=styles["Normal"], fontSize=14)),
        Paragraph(f"<b>No:</b> {doc_no}<br/><b>Date:</b> {date_key}", ParagraphStyle("r", parent=styles["Normal"], fontSize=10, alignment=2)),
    ]], colWidths=[9*cm, 9*cm])
    title_table.setStyle(TableStyle([("VALIGN", (0,0), (-1,-1), "TOP")]))
    story.append(title_table)
    story.append(Spacer(1, 10))

    # Bill to
    story.append(Paragraph("BILL TO", lbl_style))
    bill_lines = [f"<b>{customer_name}</b>"]
    if customer_mobile: bill_lines.append("Mobile: " + customer_mobile)
    if customer_address: bill_lines.append(customer_address)
    story.append(Paragraph("<br/>".join(bill_lines), body_style))
    story.append(Spacer(1, 12))

    # Items table
    if items_rows:
        header = ["#", "Item", "Qty", "Rate", "Amount"]
        table_data = [header] + items_rows
        t = Table(table_data, colWidths=[0.8*cm, 8.5*cm, 2*cm, 2.7*cm, 3*cm])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0,0), (-1,0), _colors.HexColor("#B45309")),
            ("TEXTCOLOR", (0,0), (-1,0), _colors.white),
            ("ALIGN", (2,0), (-1,-1), "RIGHT"),
            ("ALIGN", (0,0), (0,-1), "CENTER"),
            ("FONTSIZE", (0,0), (-1,-1), 10),
            ("ROWBACKGROUNDS", (0,1), (-1,-1), [_colors.HexColor("#FFF7ED"), _colors.white]),
            ("GRID", (0,0), (-1,-1), 0.5, _colors.HexColor("#F59E0B")),
            ("BOTTOMPADDING", (0,0), (-1,-1), 8),
            ("TOPPADDING", (0,0), (-1,-1), 8),
        ]))
        story.append(t)
        story.append(Spacer(1, 6))

    # Grand total
    total_table = Table(
        [["Grand total", _rupees(grand_total)]],
        colWidths=[13*cm, 4*cm],
    )
    total_table.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), _colors.HexColor("#0F172A")),
        ("TEXTCOLOR", (0,0), (-1,-1), _colors.white),
        ("ALIGN", (1,0), (1,0), "RIGHT"),
        ("FONTSIZE", (0,0), (-1,-1), 13),
        ("FONTNAME", (0,0), (-1,-1), "Helvetica-Bold"),
        ("BOTTOMPADDING", (0,0), (-1,-1), 10),
        ("TOPPADDING", (0,0), (-1,-1), 10),
    ]))
    story.append(total_table)
    story.append(Spacer(1, 10))

    if narration:
        story.append(Paragraph("NARRATION", lbl_style))
        story.append(Paragraph(narration, body_style))
        story.append(Spacer(1, 6))
    if footer_notes:
        story.append(Paragraph("NOTES", lbl_style))
        story.append(Paragraph(footer_notes, body_style))
        story.append(Spacer(1, 12))

    story.append(Spacer(1, 20))
    story.append(Paragraph(f"Generated by {generated_by} · {company_name}", sub_style))

    pdf.build(story)
    return buf.getvalue()


# ---------- Invoice endpoints ----------
@api_router.post("/invoices", response_model=Invoice)
async def create_invoice(body: InvoiceCreateBody, u=Depends(current_user)):
    if not body.customer_name.strip():
        raise HTTPException(400, "Customer name is required")
    if not body.items:
        raise HTTPException(400, "Add at least one product")
    # Compute totals
    items: List[dict] = []
    subtotal = 0.0
    for it in body.items:
        qty = float(it.qty or 0)
        rate = float(it.unit_price or 0)
        if qty <= 0 or rate < 0:
            raise HTTPException(400, "Each item needs qty>0 and rate>=0")
        amount = round(qty * rate, 2)
        items.append({"name": it.name.strip() or "Item", "qty": qty, "unit_price": rate, "amount": amount})
        subtotal += amount
    total = round(subtotal, 2)

    # Auto-link customer (unique by mobile)
    cust = await _get_or_create_customer_by_phone(
        name=body.customer_name,
        phone=body.customer_mobile,
        address=body.customer_address or "",
        owner_username=u["username"],
        explicit_id=body.customer_id,
    )
    linked_customer_id = cust["id"] if cust else body.customer_id

    inv_id = str(uuid.uuid4())
    invoice_no = await _next_doc_number("invoice")
    now = now_iso()
    date_key = today_key()

    # Payment split (cash + online). Default: entire amount is cash.
    cash_amt = body.cash_amount if body.cash_amount is not None else None
    online_amt = body.online_amount if body.online_amount is not None else None
    if cash_amt is None and online_amt is None:
        cash_amt, online_amt = total, 0.0
    elif cash_amt is None:
        cash_amt = max(0.0, total - float(online_amt or 0))
    elif online_amt is None:
        online_amt = max(0.0, total - float(cash_amt or 0))
    cash_amt = float(cash_amt or 0)
    online_amt = float(online_amt or 0)
    if cash_amt < 0 or online_amt < 0:
        raise HTTPException(400, "Cash and online amounts must be >= 0")
    if abs((cash_amt + online_amt) - total) > 0.01:
        raise HTTPException(400, f"Cash ({cash_amt}) + Online ({online_amt}) must equal invoice total ({total})")
    if cash_amt > 0 and online_amt > 0:
        pay_mode = "mixed"
    elif online_amt > 0:
        pay_mode = "online"
    else:
        pay_mode = "cash"

    # Build PDF (include payment breakdown in footer)
    rows = [[str(i+1), it["name"], f"{it['qty']:g}", _rupees(it["unit_price"]), _rupees(it["amount"])] for i, it in enumerate(items)]
    display = await _display_name_for(u["username"])
    pay_line = (
        f"Payment: MIXED · Cash {_rupees(cash_amt)} + Online {_rupees(online_amt)}"
        if pay_mode == "mixed"
        else f"Payment mode: {pay_mode.upper()}"
    )
    pdf_bytes = await _build_document_pdf(
        doc_kind="invoice", doc_no=invoice_no,
        generated_by=display, date_key=date_key,
        customer_name=body.customer_name, customer_mobile=body.customer_mobile,
        customer_address=body.customer_address or "",
        items_rows=rows, grand_total=total,
        footer_notes=(body.notes or "") + ("\n" + pay_line if body.notes else pay_line),
    )
    pdf_path = f"{APP_NAME}/invoices/{u['username']}/{invoice_no}.pdf"
    await put_object(pdf_path, pdf_bytes, "application/pdf")
    pdf_token = _make_media_token(pdf_path)

    # NOTE: Invoices no longer auto-create a linked sale record — invoices and sales
    # are tracked independently. Customer ledger sums both without dedup.
    doc = {
        "id": inv_id,
        "invoice_no": invoice_no,
        "user": u["username"],
        "customer_id": linked_customer_id,
        "customer_name": body.customer_name.strip(),
        "customer_mobile": body.customer_mobile.strip(),
        "customer_address": (body.customer_address or "").strip(),
        "items": items,
        "subtotal": subtotal,
        "total": total,
        "cash_amount": cash_amt,
        "online_amount": online_amt,
        "payment_mode": pay_mode,
        "notes": (body.notes or "").strip(),
        "sale_id": None,
        "pdf_path": pdf_path,
        "date_key": date_key,
        "created_at": now,
    }
    await db.invoices.insert_one(doc)

    # Attach any advance receipts the caller selected: link them to this invoice.
    if body.attach_receipt_ids:
        for rid in body.attach_receipt_ids:
            r = await db.receipts.find_one({"id": rid}, {"_id": 0, "customer_id": 1, "customer_mobile": 1, "source_type": 1, "reference_no": 1})
            if not r:
                continue
            # Sanity: only attach if the receipt is currently an advance (no reference / source_type=other)
            if (r.get("source_type") or "other").lower() != "other":
                continue
            if r.get("reference_no"):
                continue
            # Ensure the receipt belongs to the same customer (by id or phone)
            same = False
            if linked_customer_id and r.get("customer_id") == linked_customer_id:
                same = True
            elif body.customer_mobile and r.get("customer_mobile"):
                if norm_phone(body.customer_mobile) == norm_phone(r["customer_mobile"]):
                    same = True
            if not same:
                continue
            await db.receipts.update_one(
                {"id": rid},
                {"$set": {
                    "source_type": "invoice",
                    "source_id": inv_id,
                    "source_label": f"Invoice {invoice_no}",
                    "reference_no": invoice_no,
                }},
            )

    doc["display_name"] = display
    doc["pdf_token"] = pdf_token
    return Invoice(**doc)


@api_router.get("/invoices", response_model=List[Invoice])
async def list_invoices(limit: int = 100, user: Optional[str] = None, u=Depends(current_user)):
    q: dict = {}
    if user:
        q["user"] = user
    limit = max(1, min(500, limit))
    docs = await db.invoices.find(q, {"_id": 0}).sort("created_at", -1).limit(limit).to_list(limit)
    name_cache: dict = {}
    out: List[Invoice] = []
    # Batch-fetch linked receipts for these invoices
    ids = [d["id"] for d in docs]
    receipts_by_src: dict = {}
    if ids:
        rc_cursor = db.receipts.find(
            {"source_type": "invoice", "source_id": {"$in": ids}},
            {"_id": 0, "id": 1, "receipt_no": 1, "source_id": 1, "amount": 1, "payment_mode": 1, "pdf_path": 1, "reference_no": 1},
        )
        async for r in rc_cursor:
            receipts_by_src.setdefault(r["source_id"], []).append({
                "id": r["id"],
                "receipt_no": r["receipt_no"],
                "amount": float(r.get("amount") or 0),
                "payment_mode": (r.get("payment_mode") or "cash").lower(),
                "reference_no": r.get("reference_no") or "",
                "pdf_token": _make_media_token(r["pdf_path"]) if r.get("pdf_path") else None,
            })
    for d in docs:
        uname = d["user"]
        if uname not in name_cache:
            name_cache[uname] = await _display_name_for(uname)
        d["display_name"] = name_cache[uname]
        if d.get("pdf_path"):
            d["pdf_token"] = _make_media_token(d["pdf_path"])
        d["linked_receipts"] = receipts_by_src.get(d["id"], [])
        out.append(Invoice(**d))
    return out


@api_router.get("/invoices/{iid}", response_model=Invoice)
async def get_invoice(iid: str, u=Depends(current_user)):
    d = await db.invoices.find_one({"id": iid}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Not found")
    d["display_name"] = await _display_name_for(d["user"])
    if d.get("pdf_path"):
        d["pdf_token"] = _make_media_token(d["pdf_path"])
    return Invoice(**d)


@api_router.delete("/invoices/{iid}")
async def delete_invoice(iid: str, _=Depends(admin_only)):
    d = await db.invoices.find_one({"id": iid}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Not found")
    if d.get("sale_id"):
        await db.sales.delete_one({"id": d["sale_id"]})
    await db.invoices.delete_one({"id": iid})
    return {"deleted": True}


class InvoiceUpdateBody(BaseModel):
    customer_name: str
    customer_mobile: str
    customer_address: Optional[str] = ""
    items: List[InvoiceItemBody]
    notes: Optional[str] = ""
    customer_id: Optional[str] = None
    cash_amount: Optional[float] = None
    online_amount: Optional[float] = None
    date_key: Optional[str] = None


@api_router.put("/invoices/{iid}", response_model=Invoice)
async def replace_invoice(iid: str, body: InvoiceUpdateBody, u=Depends(admin_only)):
    """Admin: edit every field of an invoice and regenerate its PDF (same invoice number)."""
    doc = await db.invoices.find_one({"id": iid}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Not found")
    if not body.customer_name.strip():
        raise HTTPException(400, "Customer name is required")
    if not body.items:
        raise HTTPException(400, "Add at least one product")
    items: List[dict] = []
    subtotal = 0.0
    for it in body.items:
        qty = float(it.qty or 0)
        rate = float(it.unit_price or 0)
        if qty <= 0 or rate < 0:
            raise HTTPException(400, "Each item needs qty>0 and rate>=0")
        amount = round(qty * rate, 2)
        items.append({"name": it.name.strip() or "Item", "qty": qty, "unit_price": rate, "amount": amount})
        subtotal += amount
    total = round(subtotal, 2)
    date_key = (body.date_key or doc.get("date_key") or today_key()).strip()
    if not DATE_RE.match(date_key):
        raise HTTPException(400, "date_key must be YYYY-MM-DD")

    cash_amt = body.cash_amount
    online_amt = body.online_amount
    if cash_amt is None and online_amt is None:
        cash_amt, online_amt = total, 0.0
    elif cash_amt is None:
        cash_amt = max(0.0, total - float(online_amt or 0))
    elif online_amt is None:
        online_amt = max(0.0, total - float(cash_amt or 0))
    cash_amt = float(cash_amt or 0)
    online_amt = float(online_amt or 0)
    if cash_amt < 0 or online_amt < 0:
        raise HTTPException(400, "Cash and online amounts must be >= 0")
    if abs((cash_amt + online_amt) - total) > 0.01:
        raise HTTPException(400, f"Cash ({cash_amt}) + Online ({online_amt}) must equal invoice total ({total})")
    pay_mode = "mixed" if (cash_amt > 0 and online_amt > 0) else ("online" if online_amt > 0 else "cash")

    cust = await _get_or_create_customer_by_phone(
        name=body.customer_name, phone=body.customer_mobile, address=body.customer_address or "",
        owner_username=doc["user"], explicit_id=body.customer_id,
    )
    linked_customer_id = cust["id"] if cust else body.customer_id

    rows = [[str(i+1), it["name"], f"{it['qty']:g}", _rupees(it["unit_price"]), _rupees(it["amount"])] for i, it in enumerate(items)]
    display = await _display_name_for(doc["user"])
    pay_line = (
        f"Payment: MIXED · Cash {_rupees(cash_amt)} + Online {_rupees(online_amt)}"
        if pay_mode == "mixed" else f"Payment mode: {pay_mode.upper()}"
    )
    notes = (body.notes or "").strip()
    pdf_bytes = await _build_document_pdf(
        doc_kind="invoice", doc_no=doc["invoice_no"], generated_by=display, date_key=date_key,
        customer_name=body.customer_name, customer_mobile=body.customer_mobile,
        customer_address=body.customer_address or "", items_rows=rows, grand_total=total,
        footer_notes=(notes + "\n" if notes else "") + pay_line + f"\n(Edited by {u['username']} on {today_key()})",
    )
    pdf_path = doc.get("pdf_path") or f"{APP_NAME}/invoices/{doc['user']}/{doc['invoice_no']}.pdf"
    await put_object(pdf_path, pdf_bytes, "application/pdf")
    upd = {
        "customer_id": linked_customer_id,
        "customer_name": body.customer_name.strip(),
        "customer_mobile": body.customer_mobile.strip(),
        "customer_address": (body.customer_address or "").strip(),
        "items": items, "subtotal": subtotal, "total": total,
        "cash_amount": cash_amt, "online_amount": online_amt, "payment_mode": pay_mode,
        "notes": notes, "pdf_path": pdf_path, "date_key": date_key,
        "updated_at": now_iso(), "updated_by": u["username"],
    }
    await db.invoices.update_one({"id": iid}, {"$set": upd})
    # Keep linked receipts' reference/label in sync (invoice number unchanged, customer may have changed)
    await db.receipts.update_many(
        {"source_type": "invoice", "source_id": iid},
        {"$set": {"customer_id": linked_customer_id, "customer_name": body.customer_name.strip(), "customer_mobile": body.customer_mobile.strip()}},
    )
    fresh = await db.invoices.find_one({"id": iid}, {"_id": 0})
    fresh["display_name"] = display
    fresh["pdf_token"] = _make_media_token(pdf_path)
    fresh.setdefault("linked_receipts", [])
    return Invoice(**fresh)



# ---------- Money Receipt endpoints ----------
async def _resolve_source_label(source_type: str, source_id: Optional[str]) -> str:
    if not source_id: return ""
    if source_type == "sale":
        d = await db.sales.find_one({"id": source_id}, {"_id": 0, "amount": 1, "customer_name": 1, "invoice_no": 1})
        if d:
            if d.get("invoice_no"): return f"Sale · Invoice {d['invoice_no']}"
            return f"Sale · {d.get('customer_name') or ''}"
    elif source_type == "invoice":
        d = await db.invoices.find_one({"id": source_id}, {"_id": 0, "invoice_no": 1})
        if d: return f"Invoice {d.get('invoice_no')}"
    elif source_type == "collection":
        d = await db.collections.find_one({"id": source_id}, {"_id": 0, "date_key": 1})
        if d: return f"Collection · {d.get('date_key')}"
    return ""


async def _derive_reference_no(source_type: str, source_id: Optional[str]) -> str:
    """Derive a reference number from the linked source (invoice_no, short sale id, etc.).
    Returns empty string for advance payments (source_type='other' or no source_id).
    """
    if not source_id or source_type == "other":
        return ""
    if source_type == "invoice":
        d = await db.invoices.find_one({"id": source_id}, {"_id": 0, "invoice_no": 1})
        return (d or {}).get("invoice_no", "") or ""
    if source_type == "sale":
        d = await db.sales.find_one({"id": source_id}, {"_id": 0, "invoice_no": 1})
        # Prefer invoice_no if the sale is invoice-linked; else short id
        if d and d.get("invoice_no"):
            return d["invoice_no"]
        return source_id[:8].upper()
    if source_type == "collection":
        d = await db.collections.find_one({"id": source_id}, {"_id": 0, "date_key": 1})
        if d:
            return f"COL-{d.get('date_key', '').replace('-', '')}"
    return ""


async def _get_or_create_customer_by_phone(
    name: str,
    phone: str,
    address: str,
    owner_username: str,
    explicit_id: Optional[str] = None,
) -> Optional[dict]:
    """Reuse an existing customer by normalized phone; else create a fresh customer record.
    Returns the customer doc, or None if no phone/name given.
    Ensures customer records stay UNIQUE by mobile number.
    """
    if explicit_id:
        doc = await db.customers.find_one({"id": explicit_id}, {"_id": 0})
        if doc:
            return doc
    phone = (phone or "").strip()
    name = (name or "").strip()
    if not phone and not name:
        return None
    phone_n = norm_phone(phone) if phone else ""
    if phone_n:
        existing = await db.customers.find_one({"phone_norm": phone_n}, {"_id": 0})
        if existing:
            # Optionally backfill missing name/address on the existing record (non-destructive)
            patch: dict = {}
            if name and not (existing.get("name") or "").strip():
                patch["name"] = name
            if address and not (existing.get("address") or "").strip():
                patch["address"] = address
            if patch:
                patch["updated_at"] = now_iso()
                await db.customers.update_one({"id": existing["id"]}, {"$set": patch})
                existing.update(patch)
            return existing
    # Create new customer
    if not name:
        # Cannot create without name
        return None
    now = now_iso()
    doc = {
        "id": str(uuid.uuid4()),
        "name": name,
        "phone": phone,
        "phone_norm": phone_n,
        "address": address or "",
        "status": "new",
        "assigned_to": owner_username,
        "notes": "",
        "source": "auto",  # created automatically from invoice/receipt flow
        "created_at": now,
        "updated_at": now,
    }
    try:
        await db.customers.insert_one(doc)
    except Exception:
        # Race: another writer may have created it — re-fetch
        if phone_n:
            existing = await db.customers.find_one({"phone_norm": phone_n}, {"_id": 0})
            if existing:
                return existing
        raise
    doc.pop("_id", None)
    return doc


@api_router.post("/receipts", response_model=MoneyReceipt)
async def create_receipt(body: ReceiptCreateBody, u=Depends(current_user)):
    if not body.customer_name.strip():
        raise HTTPException(400, "Customer name is required")
    if body.amount < 0:
        raise HTTPException(400, "Amount must be >= 0")
    st = (body.source_type or "other").lower()
    if st not in SOURCE_TYPES:
        raise HTTPException(400, "Invalid source_type")
    mode = (body.payment_mode or "cash").lower()
    if mode not in {"cash", "online", "mixed"}:
        raise HTTPException(400, "Invalid payment_mode")

    # Compute cash/online split
    amt = float(body.amount)
    if mode == "cash":
        cash_amt = amt
        online_amt = 0.0
    elif mode == "online":
        cash_amt = 0.0
        online_amt = amt
    else:  # mixed
        cash_amt = float(body.cash_amount or 0)
        online_amt = float(body.online_amount or 0)
        if cash_amt < 0 or online_amt < 0:
            raise HTTPException(400, "Cash and online amounts must be >= 0")
        if cash_amt == 0 and online_amt == 0:
            raise HTTPException(400, "For mixed payments, enter both cash and online amounts")
        # Reconcile total: if amount not provided or mismatched, prefer explicit split
        computed = round(cash_amt + online_amt, 2)
        if amt <= 0:
            amt = computed
        elif abs(computed - amt) > 0.01:
            raise HTTPException(400, f"Cash ({cash_amt}) + Online ({online_amt}) must equal total amount ({amt})")

    # Auto-link customer (unique by mobile)
    cust = await _get_or_create_customer_by_phone(
        name=body.customer_name,
        phone=body.customer_mobile,
        address=body.customer_address or "",
        owner_username=u["username"],
        explicit_id=body.customer_id,
    )
    linked_customer_id = cust["id"] if cust else body.customer_id

    receipt_no = await _next_doc_number("receipt")
    rid = str(uuid.uuid4())
    now = now_iso()
    date_key = today_key()
    src_label = await _resolve_source_label(st, body.source_id)
    display = await _display_name_for(u["username"])

    # Determine reference number: explicit override > auto-derived from source > empty (=advance)
    if body.reference_no is not None and body.reference_no.strip():
        ref_no = body.reference_no.strip()
    else:
        ref_no = await _derive_reference_no(st, body.source_id)

    ref_line = f"\nReference: {ref_no}" if ref_no else "\n(Advance payment — no reference)"

    # PDF: show payment mode + breakdown (esp. for mixed)
    if mode == "mixed":
        items_rows = [
            ["1", f"Received against {src_label or st.capitalize()} (Cash)", "1", _rupees(cash_amt), _rupees(cash_amt)],
            ["2", f"Received against {src_label or st.capitalize()} (Online)", "1", _rupees(online_amt), _rupees(online_amt)],
        ]
        footer_extra = f"\nPayment mode: MIXED · Cash {_rupees(cash_amt)} + Online {_rupees(online_amt)}{ref_line}"
    else:
        items_rows = [["1", f"Received against {src_label or st.capitalize()}", "1", _rupees(amt), _rupees(amt)]]
        footer_extra = f"\nPayment mode: {mode.upper()}{ref_line}"

    pdf_bytes = await _build_document_pdf(
        doc_kind="receipt", doc_no=receipt_no,
        generated_by=display, date_key=date_key,
        customer_name=body.customer_name, customer_mobile=body.customer_mobile or "",
        customer_address=body.customer_address or "",
        items_rows=items_rows, grand_total=amt,
        footer_notes=(body.notes or "") + footer_extra,
        narration=body.narration or "",
    )
    pdf_path = f"{APP_NAME}/receipts/{u['username']}/{receipt_no}.pdf"
    await put_object(pdf_path, pdf_bytes, "application/pdf")

    doc = {
        "id": rid,
        "receipt_no": receipt_no,
        "user": u["username"],
        "customer_id": linked_customer_id,
        "customer_name": body.customer_name.strip(),
        "customer_mobile": (body.customer_mobile or "").strip(),
        "customer_address": (body.customer_address or "").strip(),
        "amount": amt,
        "payment_mode": mode,
        "cash_amount": cash_amt,
        "online_amount": online_amt,
        "source_type": st,
        "source_id": body.source_id,
        "source_label": src_label,
        "reference_no": ref_no,
        "narration": (body.narration or "").strip(),
        "notes": (body.notes or "").strip(),
        "pdf_path": pdf_path,
        "date_key": date_key,
        "created_at": now,
    }
    await db.receipts.insert_one(doc)
    doc["display_name"] = display
    doc["pdf_token"] = _make_media_token(pdf_path)
    return MoneyReceipt(**doc)


@api_router.get("/receipts", response_model=List[MoneyReceipt])
async def list_receipts(limit: int = 100, user: Optional[str] = None, u=Depends(current_user)):
    q: dict = {}
    if user: q["user"] = user
    limit = max(1, min(500, limit))
    docs = await db.receipts.find(q, {"_id": 0}).sort("created_at", -1).limit(limit).to_list(limit)
    out: List[MoneyReceipt] = []
    name_cache: dict = {}
    for d in docs:
        uname = d["user"]
        if uname not in name_cache:
            name_cache[uname] = await _display_name_for(uname)
        d["display_name"] = name_cache[uname]
        if d.get("pdf_path"):
            d["pdf_token"] = _make_media_token(d["pdf_path"])
        out.append(MoneyReceipt(**d))
    return out


@api_router.get("/receipts/advances")
async def list_advance_receipts_early(
    customer_id: Optional[str] = None,
    phone: Optional[str] = None,
    _=Depends(current_user),
):
    """Return money receipts that are ADVANCE payments (no reference / source_type='other')
    for a specific customer — used to attach them to a new invoice/sale at billing time.
    Note: This route must be declared BEFORE /receipts/{rid} to avoid path collision.
    """
    q: dict = {
        "$and": [
            {"source_type": "other"},
            {"$or": [
                {"reference_no": {"$in": ["", None]}},
                {"reference_no": {"$exists": False}},
            ]},
        ]
    }
    if customer_id:
        q["$and"].append({"customer_id": customer_id})
    elif phone:
        phone_n = norm_phone(phone)
        variants = list({(phone or "").strip(), phone_n} - {""})
        if variants:
            q["$and"].append({"customer_mobile": {"$in": variants}})
    else:
        raise HTTPException(400, "customer_id or phone is required")
    docs = await db.receipts.find(q, {"_id": 0}).sort("created_at", -1).limit(50).to_list(50)
    name_cache: dict = {}
    for d in docs:
        if d["user"] not in name_cache:
            name_cache[d["user"]] = await _display_name_for(d["user"])
        d["display_name"] = name_cache[d["user"]]
        if d.get("pdf_path"):
            d["pdf_token"] = _make_media_token(d["pdf_path"])
    return {"advances": docs, "count": len(docs), "total_amount": float(sum(d.get("amount", 0) for d in docs))}


@api_router.get("/receipts/source/{source_type}/{source_id}")
async def receipt_source_info(source_type: str, source_id: str, _=Depends(current_user)):
    """Resolve the customer + amount for a sale / invoice / collection so a new money
    receipt can be pre-filled from the source entry. Must be declared BEFORE /receipts/{rid}."""
    st = (source_type or "").lower()
    if st not in {"sale", "invoice", "collection"}:
        raise HTTPException(400, "source_type must be sale, invoice or collection")
    out = {
        "source_type": st, "source_id": source_id,
        "customer_id": None, "customer_name": "", "customer_mobile": "", "customer_address": "",
        "amount": 0.0, "already_receipted": 0.0, "remaining": 0.0, "label": "", "reference_no": "",
    }
    if st == "sale":
        d = await db.sales.find_one({"id": source_id}, {"_id": 0})
        if not d:
            raise HTTPException(404, "Sale not found")
        out["customer_id"] = d.get("customer_id")
        out["customer_name"] = d.get("customer_name") or ""
        out["amount"] = float(d.get("amount") or 0)
    elif st == "invoice":
        d = await db.invoices.find_one({"id": source_id}, {"_id": 0})
        if not d:
            raise HTTPException(404, "Invoice not found")
        out["customer_id"] = d.get("customer_id")
        out["customer_name"] = d.get("customer_name") or ""
        out["customer_mobile"] = d.get("customer_mobile") or ""
        out["customer_address"] = d.get("customer_address") or ""
        out["amount"] = float(d.get("total") or 0)
    else:
        d = await db.collections.find_one({"id": source_id}, {"_id": 0})
        if not d:
            raise HTTPException(404, "Collection not found")
        out["amount"] = float(d.get("grand_total") or 0)

    # Fill missing mobile/address from the linked customer record
    if out["customer_id"] and (not out["customer_mobile"] or not out["customer_address"]):
        cust = await db.customers.find_one({"id": out["customer_id"]}, {"_id": 0})
        if cust:
            out["customer_name"] = out["customer_name"] or cust.get("name", "")
            out["customer_mobile"] = out["customer_mobile"] or cust.get("phone", "")
            out["customer_address"] = out["customer_address"] or (cust.get("address") or "")
    # Legacy: sale without customer_id — best-effort match by exact name
    elif not out["customer_id"] and st == "sale" and out["customer_name"]:
        cust = await db.customers.find_one(
            {"name": {"$regex": f"^{re.escape(out['customer_name'])}$", "$options": "i"}}, {"_id": 0}
        )
        if cust:
            out["customer_id"] = cust["id"]
            out["customer_mobile"] = cust.get("phone", "")

    agg = await db.receipts.aggregate([
        {"$match": {"source_type": st, "source_id": source_id}},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
    ]).to_list(1)
    out["already_receipted"] = float(agg[0]["total"]) if agg else 0.0
    out["remaining"] = max(0.0, round(out["amount"] - out["already_receipted"], 2))
    out["label"] = await _resolve_source_label(st, source_id)
    out["reference_no"] = await _derive_reference_no(st, source_id)
    return out


@api_router.get("/receipts/{rid}", response_model=MoneyReceipt)
async def get_receipt(rid: str, u=Depends(current_user)):
    d = await db.receipts.find_one({"id": rid}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Not found")
    d["display_name"] = await _display_name_for(d["user"])
    if d.get("pdf_path"):
        d["pdf_token"] = _make_media_token(d["pdf_path"])
    return MoneyReceipt(**d)


@api_router.delete("/receipts/{rid}")
async def delete_receipt(rid: str, _=Depends(admin_only)):
    res = await db.receipts.delete_one({"id": rid})
    if res.deleted_count == 0:
        raise HTTPException(404, "Not found")
    return {"deleted": True}


@api_router.patch("/receipts/{rid}", response_model=MoneyReceipt)
async def update_receipt(rid: str, body: ReceiptPatchBody, u=Depends(admin_only)):
    """Admin can edit reference_no / source_type / source_id / narration / notes."""
    doc = await db.receipts.find_one({"id": rid}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Not found")
    upd: dict = {}
    if body.source_type is not None:
        st = (body.source_type or "other").lower()
        if st not in SOURCE_TYPES:
            raise HTTPException(400, "Invalid source_type")
        upd["source_type"] = st
    if body.source_id is not None:
        upd["source_id"] = body.source_id or None
    if body.reference_no is not None:
        upd["reference_no"] = body.reference_no.strip()
    if body.narration is not None:
        upd["narration"] = body.narration.strip()
    if body.notes is not None:
        upd["notes"] = body.notes.strip()
    if not upd:
        raise HTTPException(400, "No changes")
    # Recompute source_label if source_type/source_id changed
    if "source_type" in upd or "source_id" in upd:
        new_st = upd.get("source_type", doc.get("source_type", "other"))
        new_sid = upd.get("source_id", doc.get("source_id"))
        upd["source_label"] = await _resolve_source_label(new_st, new_sid)
        # If reference_no wasn't explicitly set, auto-derive it
        if body.reference_no is None:
            upd["reference_no"] = await _derive_reference_no(new_st, new_sid)
    await db.receipts.update_one({"id": rid}, {"$set": upd})
    fresh = await db.receipts.find_one({"id": rid}, {"_id": 0})
    fresh["display_name"] = await _display_name_for(fresh["user"])
    if fresh.get("pdf_path"):
        fresh["pdf_token"] = _make_media_token(fresh["pdf_path"])
    return MoneyReceipt(**fresh)


class ReceiptUpdateBody(BaseModel):
    customer_id: Optional[str] = None
    customer_name: str
    customer_mobile: str = ""
    customer_address: Optional[str] = ""
    amount: float
    payment_mode: str = "cash"
    cash_amount: Optional[float] = None
    online_amount: Optional[float] = None
    source_type: str = "other"
    source_id: Optional[str] = None
    reference_no: Optional[str] = None
    narration: Optional[str] = ""
    notes: Optional[str] = ""
    date_key: Optional[str] = None


@api_router.put("/receipts/{rid}", response_model=MoneyReceipt)
async def replace_receipt(rid: str, body: ReceiptUpdateBody, u=Depends(admin_only)):
    """Admin: edit every field of a money receipt and regenerate its PDF (same receipt number)."""
    doc = await db.receipts.find_one({"id": rid}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Not found")
    if not body.customer_name.strip():
        raise HTTPException(400, "Customer name is required")
    st = (body.source_type or "other").lower()
    if st not in SOURCE_TYPES:
        raise HTTPException(400, "Invalid source_type")
    mode = (body.payment_mode or "cash").lower()
    if mode not in {"cash", "online", "mixed"}:
        raise HTTPException(400, "Invalid payment_mode")
    amt = float(body.amount)
    if amt < 0:
        raise HTTPException(400, "Amount must be >= 0")
    if mode == "cash":
        cash_amt, online_amt = amt, 0.0
    elif mode == "online":
        cash_amt, online_amt = 0.0, amt
    else:
        cash_amt = float(body.cash_amount or 0)
        online_amt = float(body.online_amount or 0)
        if cash_amt < 0 or online_amt < 0:
            raise HTTPException(400, "Cash and online amounts must be >= 0")
        computed = round(cash_amt + online_amt, 2)
        if amt <= 0:
            amt = computed
        elif abs(computed - amt) > 0.01:
            raise HTTPException(400, f"Cash ({cash_amt}) + Online ({online_amt}) must equal total amount ({amt})")
    date_key = (body.date_key or doc.get("date_key") or today_key()).strip()
    if not DATE_RE.match(date_key):
        raise HTTPException(400, "date_key must be YYYY-MM-DD")

    cust = await _get_or_create_customer_by_phone(
        name=body.customer_name, phone=body.customer_mobile, address=body.customer_address or "",
        owner_username=doc["user"], explicit_id=body.customer_id,
    )
    linked_customer_id = cust["id"] if cust else body.customer_id
    src_label = await _resolve_source_label(st, body.source_id)
    if body.reference_no is not None and body.reference_no.strip():
        ref_no = body.reference_no.strip()
    else:
        ref_no = await _derive_reference_no(st, body.source_id)
    ref_line = f"\nReference: {ref_no}" if ref_no else "\n(Advance payment — no reference)"
    if mode == "mixed":
        items_rows = [
            ["1", f"Received against {src_label or st.capitalize()} (Cash)", "1", _rupees(cash_amt), _rupees(cash_amt)],
            ["2", f"Received against {src_label or st.capitalize()} (Online)", "1", _rupees(online_amt), _rupees(online_amt)],
        ]
        footer_extra = f"\nPayment mode: MIXED · Cash {_rupees(cash_amt)} + Online {_rupees(online_amt)}{ref_line}"
    else:
        items_rows = [["1", f"Received against {src_label or st.capitalize()}", "1", _rupees(amt), _rupees(amt)]]
        footer_extra = f"\nPayment mode: {mode.upper()}{ref_line}"
    display = await _display_name_for(doc["user"])
    pdf_bytes = await _build_document_pdf(
        doc_kind="receipt", doc_no=doc["receipt_no"], generated_by=display, date_key=date_key,
        customer_name=body.customer_name, customer_mobile=body.customer_mobile or "",
        customer_address=body.customer_address or "", items_rows=items_rows, grand_total=amt,
        footer_notes=(body.notes or "") + footer_extra + f"\n(Edited by {u['username']} on {today_key()})",
        narration=body.narration or "",
    )
    pdf_path = doc.get("pdf_path") or f"{APP_NAME}/receipts/{doc['user']}/{doc['receipt_no']}.pdf"
    await put_object(pdf_path, pdf_bytes, "application/pdf")
    upd = {
        "customer_id": linked_customer_id,
        "customer_name": body.customer_name.strip(),
        "customer_mobile": (body.customer_mobile or "").strip(),
        "customer_address": (body.customer_address or "").strip(),
        "amount": amt, "payment_mode": mode, "cash_amount": cash_amt, "online_amount": online_amt,
        "source_type": st, "source_id": body.source_id, "source_label": src_label, "reference_no": ref_no,
        "narration": (body.narration or "").strip(), "notes": (body.notes or "").strip(),
        "pdf_path": pdf_path, "date_key": date_key,
        "updated_at": now_iso(), "updated_by": u["username"],
    }
    await db.receipts.update_one({"id": rid}, {"$set": upd})
    fresh = await db.receipts.find_one({"id": rid}, {"_id": 0})
    fresh["display_name"] = display
    fresh["pdf_token"] = _make_media_token(pdf_path)
    return MoneyReceipt(**fresh)



@api_router.get("/receipts/advances-legacy-removed", include_in_schema=False)
async def _list_advance_receipts_legacy(_=Depends(current_user)):
    raise HTTPException(410, "Use /api/receipts/advances")


# ---------- Expenses (admin only) ----------
@api_router.post("/expenses", response_model=Expense)
async def create_expense(body: ExpenseBody, u=Depends(admin_only)):
    if body.amount < 0:
        raise HTTPException(400, "Amount must be >= 0")
    doc = {
        "id": str(uuid.uuid4()),
        "amount": float(body.amount),
        "category": body.category.strip() or "misc",
        "description": body.description or "",
        "date_key": body.date_key or today_key(),
        "created_by": u["username"],
        "created_at": now_iso(),
    }
    await db.expenses.insert_one(doc)
    doc.pop("_id", None)
    return Expense(**doc)


@api_router.get("/expenses", response_model=List[Expense])
async def list_expenses(_=Depends(admin_only), days: int = 60):
    docs = await db.expenses.find({}, {"_id": 0}).sort("date_key", -1).limit(days * 20).to_list(days * 20)
    return [Expense(**d) for d in docs]


@api_router.delete("/expenses/{eid}")
async def delete_expense(eid: str, _=Depends(admin_only)):
    res = await db.expenses.delete_one({"id": eid})
    if res.deleted_count == 0:
        raise HTTPException(404, "Not found")
    return {"deleted": True}


@api_router.get("/stats/pnl")
async def pnl(_=Depends(admin_only), days: int = 30):
    """Simple P&L summary over `days` days."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    sales_agg = await db.sales.aggregate([
        {"$match": {"date_key": {"$gte": since}}},
        {"$group": {
            "_id": None,
            "revenue": {"$sum": "$amount"},
            "cogs": {"$sum": {"$ifNull": ["$purchase_amount", 0]}},
            "count": {"$sum": 1},
        }},
    ]).to_list(1)
    exp_agg = await db.expenses.aggregate([
        {"$match": {"date_key": {"$gte": since}}},
        {"$group": {"_id": None, "expenses": {"$sum": "$amount"}, "count": {"$sum": 1}}},
    ]).to_list(1)
    revenue = sales_agg[0]["revenue"] if sales_agg else 0
    cogs = sales_agg[0]["cogs"] if sales_agg else 0
    sales_count = sales_agg[0]["count"] if sales_agg else 0
    expenses = exp_agg[0]["expenses"] if exp_agg else 0
    exp_count = exp_agg[0]["count"] if exp_agg else 0
    gross_profit = revenue - cogs
    net_profit = gross_profit - expenses
    return {
        "since": since,
        "days": days,
        "revenue": revenue,
        "cogs": cogs,
        "gross_profit": gross_profit,
        "expenses": expenses,
        "net_profit": net_profit,
        "sales_count": sales_count,
        "expense_count": exp_count,
    }


# ---------- Excel reports (admin only) ----------
def _make_report_token(kind: str) -> str:
    payload = {
        "kind": f"report:{kind}",
        "exp": datetime.now(timezone.utc) + timedelta(minutes=10),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def _check_report_auth(kind: str, token: Optional[str], cred):
    if token:
        try:
            data = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
            if data.get("kind") != f"report:{kind}":
                raise HTTPException(401, "Wrong report token")
            return
        except jwt.PyJWTError:
            raise HTTPException(401, "Invalid or expired token")
    if not cred or cred.scheme.lower() != "bearer":
        raise HTTPException(401, "Missing auth")
    try:
        payload = jwt.decode(cred.credentials, JWT_SECRET, algorithms=[JWT_ALGO])
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid token")
    if payload.get("role") != "admin":
        raise HTTPException(403, "Admin only")


@api_router.get("/reports/token")
async def report_token(kind: str, _=Depends(admin_only)):
    if kind not in {"sales", "expenses", "pnl"}:
        raise HTTPException(400, "Unknown report kind")
    return {"token": _make_report_token(kind)}


def _xlsx_response(wb: Workbook, filename: str) -> Response:
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return Response(
        content=buf.read(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@api_router.get("/reports/sales.xlsx")
async def report_sales(token: Optional[str] = Query(None),
                       cred: Annotated[Optional[HTTPAuthorizationCredentials], Depends(bearer)] = None):
    _check_report_auth("sales", token, cred)
    docs = await db.sales.find({}, {"_id": 0}).sort("timestamp", -1).to_list(50000)
    wb = Workbook()
    ws = wb.active
    ws.title = "Sales"
    ws.append(["Date", "Time", "Employee", "Customer", "Product", "Amount", "Purchase", "Profit", "Notes"])
    for d in docs:
        amt = float(d.get("amount") or 0)
        purchase = d.get("purchase_amount")
        purchase_v = float(purchase) if purchase is not None else None
        profit = amt - float(purchase_v or 0) if purchase_v is not None else None
        ts = d.get("timestamp", "")
        date_part = ts.split("T")[0] if "T" in ts else d.get("date_key", "")
        time_part = ts.split("T")[1][:8] if "T" in ts else ""
        ws.append([
            date_part, time_part,
            d.get("display_name") or d.get("user", ""),
            d.get("customer_name", ""),
            d.get("product", ""),
            amt,
            purchase_v if purchase_v is not None else "",
            profit if profit is not None else "",
            d.get("notes", ""),
        ])
    for col in ("F", "G", "H"):
        for cell in ws[col][1:]:
            cell.number_format = "#,##0.00"
    for col_letter, width in zip("ABCDEFGHI", (12, 10, 16, 22, 22, 12, 12, 12, 40)):
        ws.column_dimensions[col_letter].width = width
    return _xlsx_response(wb, "sales.xlsx")


@api_router.get("/reports/expenses.xlsx")
async def report_expenses(token: Optional[str] = Query(None),
                          cred: Annotated[Optional[HTTPAuthorizationCredentials], Depends(bearer)] = None):
    _check_report_auth("expenses", token, cred)
    docs = await db.expenses.find({}, {"_id": 0}).sort("date_key", -1).to_list(50000)
    wb = Workbook()
    ws = wb.active
    ws.title = "Expenses"
    ws.append(["Date", "Category", "Amount", "Description", "Created by", "Created at"])
    for d in docs:
        ws.append([
            d.get("date_key", ""),
            d.get("category", ""),
            float(d.get("amount") or 0),
            d.get("description", ""),
            d.get("created_by", ""),
            d.get("created_at", ""),
        ])
    for cell in ws["C"][1:]:
        cell.number_format = "#,##0.00"
    for col_letter, width in zip("ABCDEF", (12, 16, 12, 40, 14, 22)):
        ws.column_dimensions[col_letter].width = width
    return _xlsx_response(wb, "expenses.xlsx")


@api_router.get("/reports/pnl.xlsx")
async def report_pnl(token: Optional[str] = Query(None),
                     cred: Annotated[Optional[HTTPAuthorizationCredentials], Depends(bearer)] = None,
                     days: int = 30):
    _check_report_auth("pnl", token, cred)
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    # per-day rollup: revenue, cogs, expenses, net
    sales_agg = await db.sales.aggregate([
        {"$match": {"date_key": {"$gte": since}}},
        {"$group": {
            "_id": "$date_key",
            "revenue": {"$sum": "$amount"},
            "cogs": {"$sum": {"$ifNull": ["$purchase_amount", 0]}},
            "count": {"$sum": 1},
        }},
    ]).to_list(500)
    exp_agg = await db.expenses.aggregate([
        {"$match": {"date_key": {"$gte": since}}},
        {"$group": {"_id": "$date_key", "expenses": {"$sum": "$amount"}, "count": {"$sum": 1}}},
    ]).to_list(500)
    day_map: dict = {}
    for r in sales_agg:
        day_map.setdefault(r["_id"], {})["revenue"] = r["revenue"]
        day_map[r["_id"]]["cogs"] = r["cogs"]
        day_map[r["_id"]]["sales_count"] = r["count"]
    for r in exp_agg:
        day_map.setdefault(r["_id"], {})["expenses"] = r["expenses"]
        day_map[r["_id"]]["expense_count"] = r["count"]

    wb = Workbook()
    ws = wb.active
    ws.title = "P&L"
    ws.append(["Date", "Sales", "Revenue", "COGS", "Gross profit", "Expenses", "Net profit"])
    tot_rev = tot_cogs = tot_exp = 0.0
    for d in sorted(day_map.keys()):
        rev = float(day_map[d].get("revenue", 0))
        cogs = float(day_map[d].get("cogs", 0))
        exp = float(day_map[d].get("expenses", 0))
        gross = rev - cogs
        net = gross - exp
        ws.append([d, day_map[d].get("sales_count", 0), rev, cogs, gross, exp, net])
        tot_rev += rev; tot_cogs += cogs; tot_exp += exp
    ws.append([])
    ws.append(["TOTAL", "", tot_rev, tot_cogs, tot_rev - tot_cogs, tot_exp, tot_rev - tot_cogs - tot_exp])
    for col in ("C", "D", "E", "F", "G"):
        for cell in ws[col][1:]:
            cell.number_format = "#,##0.00"
    for col_letter, width in zip("ABCDEFG", (12, 8, 14, 14, 14, 14, 14)):
        ws.column_dimensions[col_letter].width = width
    return _xlsx_response(wb, "pnl.xlsx")



# ---------- File upload / download ----------
def _make_media_token(path: str) -> str:
    payload = {
        "path": path,
        "kind": "media",
        "exp": datetime.now(timezone.utc) + timedelta(minutes=30),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def _decode_media_token(token: str) -> str:
    try:
        data = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
        if data.get("kind") != "media":
            raise HTTPException(401, "Invalid media token")
        return data["path"]
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid or expired media token")


@api_router.post("/files/upload")
async def upload_file(file: UploadFile = File(...), u=Depends(current_user)):
    data = await file.read()
    if len(data) > 8 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 8MB)")
    ext = (file.filename or "").rsplit(".", 1)[-1].lower() if file.filename and "." in file.filename else "jpg"
    if ext not in {"jpg", "jpeg", "png", "webp", "heic"}:
        ext = "jpg"
    fname = f"{uuid.uuid4()}.{ext}"
    path = f"{APP_NAME}/uploads/{u['username']}/{fname}"
    await put_object(path, data, file.content_type or "image/jpeg")
    return {
        "path": path,
        "url": f"/api/files/{path}",
        "token": _make_media_token(path),
    }


@api_router.get("/files/token")
async def issue_media_token(path: str, _=Depends(current_user)):
    return {"token": _make_media_token(path)}


@api_router.get("/media/{token}")
async def get_media_by_token(token: str):
    """Open a stored file (PDF / image) using only a signed media token — used by
    'Tap to open PDF' links in the ledger, daybook and linked-receipt chips."""
    path = _decode_media_token(token)
    data, ctype = await get_object(path)
    fname = path.rsplit("/", 1)[-1]
    return Response(content=data, media_type=ctype, headers={"Content-Disposition": f'inline; filename="{fname}"'})


@api_router.get("/files/{path:path}")
async def get_file(path: str, token: Optional[str] = Query(None),
                   cred: Annotated[Optional[HTTPAuthorizationCredentials], Depends(bearer)] = None):
    # Accept either bearer auth (native) OR media token in query (web <img>).
    if token:
        allowed_path = _decode_media_token(token)
        if allowed_path != path:
            raise HTTPException(403, "Token/path mismatch")
    else:
        if not cred or cred.scheme.lower() != "bearer":
            raise HTTPException(401, "Missing auth")
        try:
            jwt.decode(cred.credentials, JWT_SECRET, algorithms=[JWT_ALGO])
        except jwt.PyJWTError:
            raise HTTPException(401, "Invalid token")

    data, ctype = await get_object(path)
    return Response(content=data, media_type=ctype)


app.include_router(api_router)
