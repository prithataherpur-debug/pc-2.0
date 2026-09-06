import { storage } from "@/src/utils/storage";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;
export const API = `${BASE}/api`;

export const TOKEN_KEY = "callflow_token";

export type User = {
  id: string;
  username: string;
  role: "admin" | "employee";
  display_name?: string | null;
  daily_goal?: number | null;
};

export type Customer = {
  id: string;
  name: string;
  phone: string;
  address?: string;
  notes?: string;
  status: string;
  assigned_to?: string | null;
  last_called_at?: string | null;
  followup_date?: string | null;
  rating?: number | null;
  feedback?: string;
  whatsapp_sent_at?: string | null;
  created_at: string;
};

export type StatsToday = {
  date: string;
  goal: number;
  total_calls: number;
  breakdown: Record<string, number>;
  pending_customers: number;
  total_customers: number;
};

export type SettingsShape = {
  daily_goal: number;
  whatsapp_template_name: string;
  whatsapp_language_code: string;
  follow_up_days: number;
};

export type AttendanceRec = {
  id?: string;
  user: string;
  display_name?: string;
  date_key: string;
  check_in?: string | null;
  check_out?: string | null;
  check_in_location?: {
    latitude?: number | null;
    longitude?: number | null;
    accuracy?: number | null;
    address?: string | null;
  } | null;
  check_out_location?: {
    latitude?: number | null;
    longitude?: number | null;
    accuracy?: number | null;
    address?: string | null;
  } | null;
  check_in_selfie?: string | null;
  check_out_selfie?: string | null;
  breaks?: { start: string; end: string | null }[] | null;
};

export type LeaderboardRow = {
  username: string;
  display_name: string;
  total: number;
  interested: number;
  sales_count: number;
  revenue: number;
  goal: number;
  pct: number;
  rank: number;
  is_me: boolean;
};

export type Sale = {
  id: string;
  user: string;
  display_name?: string | null;
  customer_id?: string | null;
  customer_name?: string;
  amount: number;
  cash_amount?: number;
  online_amount?: number;
  payment_mode?: "cash" | "online" | "mixed";
  purchase_amount?: number | null;
  profit?: number;
  currency: string;
  product?: string;
  notes?: string;
  date_key: string;
  timestamp: string;
  source?: "manual" | "invoice";
  invoice_id?: string | null;
  invoice_no?: string | null;
  linked_receipts?: LinkedReceipt[];
};

export type PreviewRow = {
  index: number;
  name: string;
  phone: string;
  phone_norm: string;
  status: "new" | "duplicate";
  reason: string | null;
  assignee_preview?: string | null;
};

export type LinkedReceipt = {
  id: string;
  receipt_no: string;
  amount: number;
  payment_mode: "cash" | "online" | "mixed";
  pdf_token?: string | null;
  customer_name?: string;
  reference_no?: string;
  source_type?: "sale" | "invoice" | "collection" | "other";
};

export type CollectionEntry = {
  id: string;
  user: string;
  display_name?: string | null;
  date_key: string;
  denominations: Record<string, number>;
  cash_total: number;
  online_total: number;
  grand_total: number;
  notes?: string;
  created_at: string;
  updated_at: string;
  linked_receipts?: LinkedReceipt[];
};

export type DailySaleEntry = CollectionEntry;

export type InvoiceItem = { name: string; qty: number; unit_price: number; amount: number };
export type Invoice = {
  id: string;
  invoice_no: string;
  user: string;
  display_name?: string | null;
  customer_id?: string | null;
  customer_name: string;
  customer_mobile: string;
  customer_address: string;
  items: InvoiceItem[];
  subtotal: number;
  total: number;
  cash_amount?: number;
  online_amount?: number;
  payment_mode?: "cash" | "online" | "mixed";
  notes: string;
  sale_id?: string | null;
  pdf_path?: string | null;
  pdf_token?: string | null;
  date_key: string;
  created_at: string;
  linked_receipts?: LinkedReceipt[];
};

export type MoneyReceipt = {
  id: string;
  receipt_no: string;
  user: string;
  display_name?: string | null;
  customer_id?: string | null;
  customer_name: string;
  customer_mobile: string;
  customer_address: string;
  amount: number;
  payment_mode: "cash" | "online" | "mixed";
  cash_amount?: number;
  online_amount?: number;
  source_type: "sale" | "invoice" | "collection" | "other";
  source_id?: string | null;
  source_label?: string | null;
  reference_no?: string;
  narration: string;
  notes: string;
  pdf_path?: string | null;
  pdf_token?: string | null;
  date_key: string;
  created_at: string;
  /** Daybook only: true = counted as fresh money in grand total; false = informational (linked to a source counted today) */
  counted_standalone?: boolean;
};

export const DENOMS = [500, 200, 100, 50, 20, 10] as const;

async function authHeaders(): Promise<Record<string, string>> {
  const t = await storage.secureGet(TOKEN_KEY, "");
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = {
    "Content-Type": "application/json",
    ...(await authHeaders()),
    ...(init?.headers || {}),
  } as Record<string, string>;
  const res = await fetch(`${API}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${path} ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as any;
  return res.json();
}

export type DaybookPhoto = {
  id: string; date_key: string; path: string; caption: string; user: string;
  created_at: string; token?: string; display_name?: string;
};

export type DaybookData = {
  date: string;
  due_collection: { cash: number; online: number; total: number; entries: CollectionEntry[] };
  daily_sales: { cash: number; online: number; total: number; entries: DailySaleEntry[] };
  sales: { cash: number; online: number; total: number; entries: Sale[] };
  receipts: { cash: number; online: number; total: number; entries: MoneyReceipt[] };
  standalone_receipts: { cash: number; online: number; total: number };
  invoices: { cash: number; online: number; total: number; entries: Invoice[] };
  grand_total: { cash: number; online: number; total: number };
  expected_cash: number;
  cash_verification: {
    id: string; date_key: string; denominations: Record<string, number>; cash_total: number;
    note: string; verified_by: string; verified_by_name?: string; verified_at: string;
  } | null;
  photos: DaybookPhoto[];
  total_collection: {
    daily_sales: number; cash_in_hand: number | null; sales: number; invoices: number; due_collection: number;
    money_receipts: number; standalone_receipts: number; grand_total: number;
  };
  reconciliation: {
    verified: boolean;
    match: boolean;
    expected_cash: number;
    counted_cash: number | null;
    variance_total: number;
    denominations: Record<string, number>;
    note?: string | null;
    verified_by?: string | null;
    verified_by_name?: string | null;
    verified_at?: string | null;
    acknowledgement?: string | null;
    acknowledged_by?: string | null;
    acknowledged_at?: string | null;
  };
};

export const api = {
  login: (username: string, password: string) =>
    req<{ access_token: string; user: User }>(`/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => req<User>(`/auth/me`),

  listUsers: () => req<User[]>(`/admin/users`),
  createUser: (payload: {
    username: string;
    password: string;
    display_name?: string;
    daily_goal?: number;
  }) =>
    req<User>(`/admin/users`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deleteUser: (username: string, reassign_to?: string) => {
    const q = reassign_to ? `?reassign_to=${encodeURIComponent(reassign_to)}` : "";
    return req<{ deleted: string; customers_moved: number; reassigned_to: string | null }>(
      `/admin/users/${encodeURIComponent(username)}${q}`,
      { method: "DELETE" },
    );
  },
  updateUser: (
    username: string,
    patch: {
      display_name?: string;
      password?: string;
      daily_goal?: number;
      reset_daily_goal?: boolean;
      new_username?: string;
    },
  ) =>
    req<User>(`/admin/users/${encodeURIComponent(username)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  teamStats: () =>
    req<{
      date: string;
      default_goal: number;
      rows: {
        id: string;
        username: string;
        display_name: string;
        daily_goal: number;
        is_custom_goal: boolean;
        calls: number;
        pct: number;
        sales_count: number;
        revenue: number;
        attendance: "absent" | "active" | "done";
        check_in?: string | null;
        check_out?: string | null;
        customers_total: number;
      }[];
    }>(`/admin/team-stats`),
  reassign: (customer_ids: string[], new_owner: string) =>
    req<{ updated: number }>(`/admin/reassign`, {
      method: "POST",
      body: JSON.stringify({ customer_ids, new_owner }),
    }),
  userCalls: (username: string, limit = 100) =>
    req<
      {
        id: string;
        customer_id: string;
        customer_name: string;
        phone: string;
        status: string;
        date_key: string;
        user: string;
        timestamp: string;
      }[]
    >(`/admin/users/${encodeURIComponent(username)}/calls?limit=${limit}`),
  userSales: (username: string, limit = 100) =>
    req<Sale[]>(`/admin/users/${encodeURIComponent(username)}/sales?limit=${limit}`),
  moveCalls: (ids: string[], new_owner: string) =>
    req<{ updated: number }>(`/admin/calls/reassign`, {
      method: "POST",
      body: JSON.stringify({ ids, new_owner }),
    }),
  moveSales: (ids: string[], new_owner: string) =>
    req<{ updated: number }>(`/admin/sales/reassign`, {
      method: "POST",
      body: JSON.stringify({ ids, new_owner }),
    }),
  deleteCall: (id: string) =>
    req<{ deleted: boolean }>(`/admin/calls/${id}`, { method: "DELETE" }),
  updateSale: (
    id: string,
    patch: {
      amount?: number; product?: string; notes?: string; purchase_amount?: number;
      cash_amount?: number; online_amount?: number; customer_name?: string; date_key?: string;
    },
  ) => req<Sale>(`/sales/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  // ---- Daily Due Collection ----
  getCollector: () =>
    req<{ collector: User | null }>(`/collector`),
  setCollector: (username: string | null) =>
    req<{ collector: User | null }>(`/admin/collector`, {
      method: "PUT",
      body: JSON.stringify({ username }),
    }),
  listCollections: (fromDate?: string, toDate?: string, limit = 100) => {
    const p = new URLSearchParams();
    if (fromDate) p.set("from_date", fromDate);
    if (toDate) p.set("to_date", toDate);
    p.set("limit", String(limit));
    return req<CollectionEntry[]>(`/collections?${p.toString()}`);
  },
  createCollection: (body: {
    date_key?: string;
    cash_total?: number;
    online_total?: number;
    notes?: string;
  }) =>
    req<CollectionEntry>(`/collections`, { method: "POST", body: JSON.stringify(body) }),
  updateCollection: (id: string, body: {
    date_key?: string;
    cash_total?: number;
    online_total?: number;
    notes?: string;
  }) =>
    req<CollectionEntry>(`/collections/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteCollection: (id: string) =>
    req<{ deleted: boolean }>(`/collections/${id}`, { method: "DELETE" }),
  collectionsSummary: (days = 7) =>
    req<{ days: { date: string; cash: number; online: number; total: number }[]; totals: { cash: number; online: number; total: number } }>(
      `/collections/summary?days=${days}`,
    ),

  // ---- Daily Sales (per employee cash + online) & Daybook ----
  listDailySales: (fromDate?: string, toDate?: string, user?: string, limit = 200) => {
    const p = new URLSearchParams();
    if (fromDate) p.set("from_date", fromDate);
    if (toDate) p.set("to_date", toDate);
    if (user) p.set("user", user);
    p.set("limit", String(limit));
    return req<DailySaleEntry[]>(`/daily-sales?${p.toString()}`);
  },
  createDailySale: (body: {
    date_key?: string;
    denominations: Record<string, number>;
    online_total: number;
    notes?: string;
    user?: string;
  }) =>
    req<DailySaleEntry>(`/daily-sales`, { method: "POST", body: JSON.stringify(body) }),
  updateDailySale: (id: string, body: {
    date_key?: string;
    denominations?: Record<string, number>;
    online_total?: number;
    notes?: string;
    user?: string;
  }) =>
    req<DailySaleEntry>(`/daily-sales/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteDailySale: (id: string) =>
    req<{ deleted: boolean }>(`/daily-sales/${id}`, { method: "DELETE" }),
  getDaybook: (date: string) =>
    req<DaybookData>(`/daybook?date=${date}`),
  saveCashVerification: (body: { date_key: string; denominations: Record<string, number>; note?: string }) =>
    req<DaybookData>(`/daybook/cash-verification`, { method: "PUT", body: JSON.stringify(body) }),
  clearCashVerification: (date: string) =>
    req<{ deleted: boolean }>(`/daybook/cash-verification?date=${date}`, { method: "DELETE" }),
  addDaybookPhoto: (body: { date_key: string; path: string; caption?: string }) =>
    req<DaybookPhoto>(`/daybook/photos`, { method: "POST", body: JSON.stringify(body) }),
  deleteDaybookPhoto: (id: string) =>
    req<{ deleted: boolean }>(`/daybook/photos/${id}`, { method: "DELETE" }),
  backupToken: () => req<{ token: string }>(`/admin/backup/token`),
  ackReconcile: (date_key: string, acknowledgement: string) =>
    req<{ ok: boolean; acknowledged_at: string }>(`/daybook/reconcile-ack`, {
      method: "POST", body: JSON.stringify({ date_key, acknowledgement }),
    }),
  daybookExportToken: (from: string, to?: string) =>
    req<{ token: string }>(`/daybook/export-token?from=${from}${to ? `&to=${to}` : ""}`),
  getCustomerLedger: (customerId: string) =>
    req<{
      customer: Customer;
      summary: {
        total_billed: number; total_billed_manual: number; total_invoices: number;
        total_received: number; due_balance: number;
        overdue_total?: number; overdue_count?: number;
      };
      timeline: {
        kind: "sale" | "invoice" | "receipt";
        id: string; when: string; amount: number; title: string; by?: string; notes?: string;
        pdf_token?: string | null; invoice_no?: string | null;
        items_count?: number; payment_mode?: string; source_type?: string; source_label?: string;
        source?: string; overdue?: boolean;
        receipts?: { id: string; receipt_no: string; amount: number; pdf_token?: string | null }[];
      }[];
      counts: { sales: number; invoices: number; receipts: number };
    }>(`/customers/${customerId}/ledger`),

  // ---- Invoice ----
  listInvoices: (limit = 100, user?: string, date?: string) => {
    const p = new URLSearchParams();
    p.set("limit", String(limit));
    if (user) p.set("user", user);
    if (date) p.set("date", date);
    return req<Invoice[]>(`/invoices?${p.toString()}`);
  },
  createInvoice: (body: {
    customer_name: string; customer_mobile: string; customer_address?: string;
    items: { name: string; qty: number; unit_price: number }[];
    notes?: string; customer_id?: string;
    attach_receipt_ids?: string[];
    cash_amount?: number; online_amount?: number;
  }) => req<Invoice>(`/invoices`, { method: "POST", body: JSON.stringify(body) }),
  getInvoice: (id: string) => req<Invoice>(`/invoices/${id}`),
  replaceInvoice: (id: string, body: {
    customer_name: string; customer_mobile: string; customer_address?: string;
    items: { name: string; qty: number; unit_price: number }[];
    notes?: string; customer_id?: string; cash_amount?: number; online_amount?: number; date_key?: string;
  }) =>
    req<Invoice>(`/invoices/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteInvoice: (id: string) => req<{ deleted: boolean }>(`/invoices/${id}`, { method: "DELETE" }),

  // ---- Money Receipt ----
  listReceipts: (limit = 100, user?: string, date?: string) => {
    const p = new URLSearchParams();
    p.set("limit", String(limit));
    if (user) p.set("user", user);
    if (date) p.set("date", date);
    return req<MoneyReceipt[]>(`/receipts?${p.toString()}`);
  },
  getReceiptSource: (sourceType: "sale" | "invoice" | "collection", sourceId: string) =>
    req<{
      source_type: string; source_id: string;
      customer_id: string | null; customer_name: string; customer_mobile: string; customer_address: string;
      amount: number; already_receipted: number; remaining: number; label: string; reference_no: string;
    }>(`/receipts/source/${sourceType}/${sourceId}`),
  createReceipt: (body: {
    customer_name: string; customer_mobile?: string; customer_address?: string;
    amount: number; payment_mode: "cash" | "online" | "mixed";
    cash_amount?: number; online_amount?: number;
    source_type: "sale" | "invoice" | "collection" | "other";
    source_id?: string;
    reference_no?: string;
    narration?: string; notes?: string;
    customer_id?: string;
  }) => req<MoneyReceipt>(`/receipts`, { method: "POST", body: JSON.stringify(body) }),
  updateReceipt: (id: string, body: {
    reference_no?: string; source_type?: "sale" | "invoice" | "collection" | "other";
    source_id?: string | null; narration?: string; notes?: string;
  }) => req<MoneyReceipt>(`/receipts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  getAdvanceReceipts: (opts: { customer_id?: string; phone?: string }) => {
    const p = new URLSearchParams();
    if (opts.customer_id) p.set("customer_id", opts.customer_id);
    if (opts.phone) p.set("phone", opts.phone);
    return req<{ advances: MoneyReceipt[]; count: number; total_amount: number }>(`/receipts/advances?${p.toString()}`);
  },
  getReceipt: (id: string) => req<MoneyReceipt>(`/receipts/${id}`),
  replaceReceipt: (id: string, body: {
    customer_id?: string; customer_name: string; customer_mobile: string; customer_address?: string;
    amount: number; payment_mode: string; cash_amount?: number; online_amount?: number;
    source_type: string; source_id?: string; reference_no?: string; narration?: string; notes?: string; date_key?: string;
  }) =>
    req<MoneyReceipt>(`/receipts/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteReceipt: (id: string) => req<{ deleted: boolean }>(`/receipts/${id}`, { method: "DELETE" }),

  listCustomers: (status = "all", search = "", scope: "mine" | "all" = "mine") =>
    req<Customer[]>(
      `/customers?status=${encodeURIComponent(status)}&search=${encodeURIComponent(search)}&scope=${scope}`,
    ),
  lookupCustomer: (phone: string) =>
    req<{ exists: boolean; customer?: Customer & { is_mine?: boolean } }>(
      `/customers/lookup?phone=${encodeURIComponent(phone)}`,
    ),
  searchCustomers: (q: string, limit = 20) =>
    req<{ customers: (Customer & { is_mine?: boolean; assigned_to?: string | null })[]; count: number }>(
      `/customers/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  createCustomer: (name: string, phone: string, notes = "", address = "") =>
    req<Customer>(`/customers`, {
      method: "POST",
      body: JSON.stringify({ name, phone, notes, address }),
    }),
  updateCustomer: (id: string, patch: { name?: string; phone?: string; address?: string; notes?: string }) =>
    req<Customer>(`/customers/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  bulkCreate: (customers: { name: string; phone: string; notes?: string }[]) =>
    req<{ inserted: number; duplicates: number }>(`/customers/bulk`, {
      method: "POST",
      body: JSON.stringify({ customers }),
    }),
  previewBulk: (customers: { name: string; phone: string; notes?: string }[]) =>
    req<{ total: number; new: number; duplicates: number; rows: PreviewRow[] }>(
      `/customers/preview-bulk`,
      { method: "POST", body: JSON.stringify({ customers }) },
    ),
  updateStatus: (id: string, status: string) =>
    req<Customer>(`/customers/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  submitFeedback: (id: string, rating: number, notes: string) =>
    req<Customer>(`/customers/${id}/feedback`, {
      method: "POST",
      body: JSON.stringify({ rating, notes }),
    }),
  deleteCustomer: (id: string) =>
    req<{ deleted: boolean }>(`/customers/${id}`, { method: "DELETE" }),
  clearAll: () => req<{ cleared: boolean }>(`/customers`, { method: "DELETE" }),

  followups: () => req<Customer[]>(`/followups`),

  statsToday: () => req<StatsToday>(`/stats/today`),
  statsHistory: () =>
    req<{
      history: { date: string; total: number; breakdown: Record<string, number> }[];
    }>(`/stats/history`),
  leaderboard: () =>
    req<{ date: string; goal: number; rows: LeaderboardRow[] }>(`/stats/leaderboard`),

  getSettings: () => req<SettingsShape>(`/settings`),
  updateSettings: (patch: Partial<SettingsShape>) =>
    req<SettingsShape>(`/settings`, { method: "PATCH", body: JSON.stringify(patch) }),

  checkIn: (loc: { latitude?: number; longitude?: number; accuracy?: number; address?: string; selfie_path?: string }) =>
    req<AttendanceRec>(`/attendance/check-in`, {
      method: "POST",
      body: JSON.stringify(loc),
    }),
  checkOut: (loc: { latitude?: number; longitude?: number; accuracy?: number; address?: string; selfie_path?: string }) =>
    req<AttendanceRec>(`/attendance/check-out`, {
      method: "POST",
      body: JSON.stringify(loc),
    }),
  attendanceToday: () =>
    req<{ today: string; records: AttendanceRec[] }>(`/attendance/today`),
  attendanceHistory: () =>
    req<{ records: AttendanceRec[] }>(`/attendance/history`),
  breakStart: () => req<AttendanceRec>(`/attendance/break-start`, { method: "POST" }),
  breakEnd: () => req<AttendanceRec>(`/attendance/break-end`, { method: "POST" }),

  listSales: (scope: "mine" | "all" = "all", date?: string) =>
    req<Sale[]>(`/sales?scope=${scope}${date ? `&date=${date}` : ""}`),
  createSale: (payload: {
    customer_id?: string | null;
    customer_name?: string;
    amount: number;
    currency?: string;
    product?: string;
    notes?: string;
  }) =>
    req<Sale>(`/sales`, { method: "POST", body: JSON.stringify(payload) }),
  deleteSale: (id: string) => req<{ deleted: boolean }>(`/sales/${id}`, { method: "DELETE" }),
  salesToday: (scope?: "mine" | "all") =>
    req<{ date: string; count: number; revenue: number; profit?: number; by_user: any[] }>(
      `/stats/sales-today${scope ? `?scope=${scope}` : ""}`,
    ),
};

export const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  interested: "Interested",
  not_interested: "Not Interested",
  callback: "Callback",
  no_answer: "No Answer",
  done: "Done",
};

export const STATUS_COLOR: Record<string, string> = {
  pending: "#C7C7CC",
  interested: "#2E8B57",
  not_interested: "#E74C3C",
  callback: "#D4AC0D",
  no_answer: "#34495E",
  done: "#D35400",
};
