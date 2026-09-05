# Pritha Cabinet — PRD

## What the app does
Multi-user sales-call CRM. 1 admin + 7 employees log in and work through their own daily call list. Admin imports customer lists, target is 50 calls per employee per day. Full sales-to-P&L pipeline with Excel exports.

## Branding
- App name: **Pritha Cabinet**. Bundle IDs unchanged: `com.emergent.massdialer.lyuxkb`.
- Logo (red circle, black/yellow "cP" mark) at `assets/images/icon.png` — also used as adaptive icon and splash.
- Primary brand color for accents remains `#D35400`; splash & Android adaptive background are `#DC2626` (red) to match the logo.

## Auth
- JWT (bcrypt). Seeded: `admin` and `emp1`…`emp7`. Credentials in `/app/memory/test_credentials.md`.

## Customer list
- CSV / paste / manual add. Unique-phone constraint. Round-robin assignment. Admin can reassign.
- Bulk-import preview screen before commit.

## Daily call flow
- Tap-to-dial → status modal → on **Interested**: Meta WhatsApp template auto-sent + follow-up date scheduled + Feedback screen.

## Progress tab
- Personal daily-goal + per-status tiles + leaderboard (top-3 medals, current user highlighted, sales column visible).
- **Attendance card** with GPS + front-camera **selfie** (via Emergent Object Storage) + **break timer**.

## Sales & Finance (admin)
- **Punch a sale** from Progress leaderboard pill, Follow-ups card, or Sales screen.
- Punch-sale modal has an inline **"New customer"** mode — employee can enter name + phone + amount in one shot; a new customer record is auto-created and assigned to that employee.
- Admin can inline-edit the **purchase amount (COGS)** on any sale → app auto-calculates profit/loss and shows a green/red chip.
- **Expenses screen** (admin-only) with categories (marketing, office, salaries, utilities, travel, misc).
- **Reports screen** (admin-only) shows last-30-day P&L card (revenue − cogs − expenses = net profit) and downloads three **Excel files** via short-lived signed URLs:
  - `sales.xlsx` — every sale with Amount / Purchase / Profit columns
  - `expenses.xlsx` — every expense entry
  - `pnl.xlsx` — day-by-day P&L with totals row

## Team management (admin)
- More → **Manage team** (`/team`) shows a **live snapshot** of the entire team.
- **Add** pill opens the add-employee sheet.
- Pencil icon on each row opens the edit sheet (display name, login ID, password, daily goal, delete-with-reassign).
- **Tapping a row** now opens `/team/<username>` — the employee's detail page with **Calls** and **Sales** tabs. Admin can:
  - Multi-select rows and **Move to…** another employee (bulk reassign of calls or sales).
  - Delete any call log or sale entry with the trash icon (admin-only).
- Renaming a user auto-cascades across customers, calls, sales, attendance, expenses and push tokens.

## Sales permissions
- **Employees** can now edit their **own** sales — amount / product / notes via a pencil icon on the sales list.
- **Purchase amount / cost** remains admin-only (protects P&L integrity).
- **Deleting** sales or call logs is admin-only.

## Due collection (daily cash & online)
- Admin designates one employee as the **collector** (More → Due collection → **Assign / Change**). Admin can swap the collector anytime; renaming or deleting the collector automatically clears / migrates the setting.
- The collector (or admin) can add a daily entry with:
  - **Cash by denomination pcs**: ₹500, ₹200, ₹100, ₹50, ₹20, ₹10 — a live "Cash total" recomputes as pcs are entered.
  - **Online amount** — separate input.
  - **Notes** — freeform.
- Grand total (cash + online) is calculated automatically and displayed in a highlighted bar.
- List view groups every entry by date with cash / online / grand total chips and denomination breakdown pills.
- **Every employee** now sees the "Due collection" ledger (workspace-wide read-only view); only the designated collector or admin can add entries. Admin can edit / delete anything.

## Daybook (consolidated day register)
- **More → Daybook** — one screen showing the full workspace picture for any given day.
- **Total Collection** card + a breakdown card that itemises **Cash in Hand**, **Invoices**, **Due Collection**, and **Money Receipts** so admin can see every source of cash at a glance.
- **Cash Verification** section (physical denomination count) — logs cash in hand with a ₹500/₹200/₹100/₹50/₹20/₹10 breakdown; shows an inline card comparing **Cash in Hand vs Expected Cash** (from due collections + standalone money receipts) with a variance indicator (green if match, amber if off).
- **Denomination Reconciliation** — auto cross-checks sum of employees' cash denominations against the collector's plain cash total. Admin can add a note and **acknowledge** any variance; the acknowledgement is displayed inline with the admin username and timestamp.
- **Any employee** can post a **Due Collection** entry (simple cash + online amounts).
- Date navigator (prev / today / next) lets you scrub any past day.
- Four collapsible sections: **Cash Verification**, **Invoices**, **Due Collection**, **Money Receipts** — each row shows details + a tap-to-open PDF for invoices/receipts.
- **Duplicate-prevention linking**: each daily-sale/collection/invoice row displays badges of money receipts already linked to it (source_type + source_id match) so employees don't create duplicate receipts.
- Grand total avoids double-counting: linked receipts don't add to totals; only `source_type='other'` receipts add fresh cash.
- Owner or admin can edit a daily-sale row; admin can delete.
- From any **Due Collection** entry, **any employee** can tap "Create money receipt" — the receipts editor opens pre-linked to that collection.

## Sales screen
- Individual customer sale rows carry **linked-receipt badges** (tap to open the PDF) — same duplicate-prevention pattern as Daybook. If no receipt exists yet, a dashed "**+ Receipt**" chip opens the money-receipts editor pre-linked to that sale.
- Each sale row also has a "**Ledger**" button that opens the customer's full running statement.

## Customer Ledger (running statement)
- **Sales card → Ledger button** on any sale (or deep-link to `/customer/[id]/ledger`).
- Shows a big Amount Due / Advance Paid / Settled card (red / green / grey) with **Billed** vs **Received** breakdown.
- 3 tiles: Sales · Invoices · Receipts count.
- Quick actions: **New receipt** / **New invoice** pre-filled with customer name.
- Chronological **timeline** of every sale, invoice, and receipt for that customer with icon-coded dots, direction (+/−), tap-to-open PDFs.
- Receipts are matched to the customer via `customer_id` first, then falling back to `customer_mobile` (phone) so legacy records without a customer link still appear.

## Money Receipts

- Every receipt carries a **Reference Number** — auto-derived from the linked source:
  - Sale linked to an invoice → invoice number
  - Standalone sale → short sale id
  - Invoice → invoice number
  - Collection → `COL-YYYYMMDD`
  - "Other" with empty reference → **ADVANCE PAYMENT** (yellow chip)
- Any employee can create a receipt. Admin can edit the reference / source type on any receipt later (dedicated "Edit ref" button on each row).
- Mixed payment mode captures explicit cash + online split (both must sum to total).
- Auto-links customer by mobile (unique) — reuses an existing customer or creates one on the fly.
- Every receipt is a live PDF (reportlab) stored on Emergent Object Storage; one-tap WhatsApp share.

## Invoices

- Bill generation → auto-creates a sale + a PDF; auto-links customer by mobile.
- When creating an invoice for a customer, the editor shows all **advance money receipts** for that customer (matched by phone or customer_id) with a checkbox list. Attached receipts are automatically linked to the new invoice with the invoice number as their reference.
- Explicit safety: attaches only skip if the receipt belongs to a different customer or already has a reference.

- **More → Invoices** — any employee or admin generates a multi-product invoice with **customer name, mobile, address, product line items (name / qty / rate)** and optional notes.
- Live per-row amount + grand total in the editor. Server assigns **INV-000001** monotonically and generates a **branded PDF** (Pritha Cabinet logo + company address / GSTIN / phone from Settings) via reportlab, uploads to Object Storage.
- Each invoice **auto-creates a linked sale** tagged `source='invoice'` so invoice-revenue is tracked separately from manual sales.
- List view shows the invoice number, customer, total, employee, and buttons for **Open PDF** and **Share via WhatsApp** (uses `wa.me/<phone>` deep-link pre-filled with the PDF URL). Admin can delete an invoice, which also removes the linked sale.

## Money receipts
- **More → Money receipts** — any employee or admin logs a payment received from a customer (proof of payment).
- Fields: customer name / mobile / address, amount, **payment mode** (cash / online / mixed), **source** (sale / invoice / collection / other), **narration** (for advance payments like "customer wants to buy X").
- When source is an invoice, the receipt shows "Invoice INV-XXXXXX" on the PDF so the customer can tie the payment to that invoice.
- Server assigns RCPT-000001 monotonically, generates the PDF, and returns a signed download URL.
- List view has Open PDF + Share via WhatsApp on each row; admin can delete.

## Sales revenue attribution
- `/api/stats/sales-today.by_source` returns `{ manual: {count, revenue}, invoice: {count, revenue} }` so P&L reports can separate walk-in sales from invoice-sales.

## Admin self-service account
- More → **My account** (`/account`) — admin can update their **display name**, **login ID**, and **password**. Changing login ID or password signs the admin out after a 1.2 s toast so they can re-authenticate with the new credentials.

## Duplicate-phone smart handoff
- If an employee types an already-existing phone in the "New customer" tab of Punch Sale, a yellow banner surfaces the existing customer (with assignment info) and a **Use** button switches to Existing mode with that customer pre-selected — one tap to reuse instead of erroring out.

## Customer search (name OR mobile)
- New endpoint `GET /api/customers/search?q=<term>` — partial case-insensitive match across **name AND phone**. Returns up to 20 customers regardless of assignee; all employees have access.
- Home tab has a **Customer Ledger** quick-lookup pill: tap → modal search by name or mobile → jump straight to that customer's ledger.
- `CustomerPicker` (Existing Customer tab) now searches by name OR mobile with a live results list.

## Money-receipt reference numbers on lists
- The linked-receipt chips on **Sales**, **Invoices**, **Due Collections**, and every **Daybook** section now render the actual `reference_no` (in orange) next to the auto-generated receipt number — so audit trails are one glance away.
- Invoices screen also shows a "Create money receipt" CTA when no receipt is linked yet.

## Deployment health probe
- Root-level `GET /health` returns `{"status":"ok"}` so K8s liveness/readiness probes stop 404-ing.

## Branding
- Home/Calls tab header now shows the **Pritha Cabinet logo** and brand tagline above the greeting.

## Push notifications
- Emergent-managed. Fires on: Interested, Callback, halfway, goal reached, sale logged. Requires real device build.

## Env vars
- `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `DEFAULT_EMPLOYEE_PASSWORD`
- `EMERGENT_LLM_KEY` — Emergent Object Storage
- `EMERGENT_PUSH_KEY` — set at deploy
- `META_WA_ACCESS_TOKEN`, `META_WA_PHONE_NUMBER_ID`, `META_WA_API_VERSION=v22.0`

## Update — Sales visibility + Daybook online fix (Sep 2026)
- **Sales visible to all employees**: `GET /api/sales` now defaults to `scope=all` for every role (scope=mine narrows). Sales screen shows the "All employees / My sales" toggle to everyone. Invoices, Money Receipts and Due Collections were already workspace-wide.
- **Daybook — online not showing (root cause)**: punched Sales (cash/online split) were never included in the Daybook, so online money received via sales was missing from Grand Total / Cash verification. Fixed:
  - `GET /api/daybook` now returns a `sales` section (manual sales for the day, with linked receipts) and `standalone_receipts` totals.
  - Standalone receipts = source_type=other OR receipts whose source (sale/invoice/collection) is not listed on that day (paid later / source deleted) → counted as fresh inflow.
  - Grand total = sales + invoices + due collection + standalone receipts (cash & online).
  - Frontend Daybook: new "Sales" tile + section (SaleRow), Cash verification shows "From sales (cash/online portion)".
- **Receipt flags (Daybook)**: each money receipt shows a COUNTED (green ✓, added to grand total) or LINKED (grey, informational — its sale/invoice/collection already counted today) tag, driven by backend `counted_standalone`. Section subtitle explains the legend.
- **Receipt auto-fill from source**: `GET /api/receipts/source/{sale|invoice|collection}/{id}` resolves customer (id/name/mobile/address via linked customer record), total, already-receipted, remaining, label & reference. Receipt editor auto-fetches it when opened via "+ Receipt" from Sales/Invoices/Collections; CustomerPicker switches to "Existing customer" with the selected card; amount defaults to remaining; ref no. prefilled.
- **Tap to source**: LINKED tag on Daybook receipts navigates to /sales, /invoices or /collections with `?highlight=<id>`; target screens scroll to and highlight the card for ~6s.
- Sales screen summary tiles follow scope (Team vs My) — `GET /api/stats/sales-today?scope=all|mine`.
- **Ledger "Billed"** = manual sales + invoices (backend `summary.total_billed` now includes invoices; banner shows Sales/Inv split).
- **Daybook Excel export (P0 DONE)**: `GET /api/daybook/export-token?from&to` (admin or assigned collector) → `GET /api/daybook.xlsx?token=` (10-min JWT). Sheets: Summary (per-day grand/cash/online, sales, invoices, due collection, standalone receipts, cash-in-hand, expected cash, variance, reconciliation note), Sales, Invoices, Due Collection, Money Receipts (Counted/Linked column), Cash Count (denominations). Daybook header download button → chooser: This day / Last 7 days / This month. Max range 62 days. Daybook computation refactored into `_build_daybook(day)`.
- **Admin edits cash counts**: Daybook cash-count rows are now fully tappable with clear "Edit"/"Delete" chips (admin: any row; employee: own). Editor shows a "Counted by (employee)" chooser for admin — admin can log a cash count on behalf of an employee or move an entry to another employee (`user` field on POST/PATCH /api/daily-sales, admin-only, 403 otherwise).

## Daybook rework + admin edits + backup (Sep 2026, session 2)
- **Daybook = admin + collector only** (`GET /api/daybook` uses `admin_or_collector`; other employees see an "Admin & collector only" screen). App shell on web is a centered max-width column (`_layout.tsx` webShell) — admin/collector use it on computers; Daybook uses a 2-column layout ≥900px.
- **Per-employee "Cash count" removed** from Daybook UI (daily_sales endpoints kept for legacy). Replaced by `src/components/CashDesk.tsx`:
  - Expected cash card (sales/invoices/due collection/standalone receipts cash + online breakdown).
  - **Cash calculator**: denominations ₹500…₹10 with ± steppers, live counted total, expected cash, variance (Matched/Short/Excess). `PUT /api/daybook/cash-verification` (one record per date in `cash_verifications`), admin can clear (`DELETE`). Daybook `reconciliation` now = {verified, match, expected_cash, counted_cash, variance_total, denominations, note, verified_by…}.
  - **Cash desk photos**: capture with back camera (SelfieCapture now supports `facing`, `hint`, `permissionText`, `maxWidth`), uploaded via `/api/files/upload`, saved with `POST /api/daybook/photos` (`daybook_photos`), grid + full-screen viewer, delete (admin/owner).
  - Excel export "Cash Count" sheet now = cash verification row per day (+ photo count).
- **`GET /api/media/{token}`** added — previously missing, so "Tap to open PDF" in ledger/daybook/linked-receipt chips 404'd. Ledger sale events now include linked `receipts[]` with pdf tokens; ledger shows "Open PDF" buttons.
- **Admin full edit**: `PUT /api/invoices/{id}` and `PUT /api/receipts/{id}` (all fields, same number, PDF regenerated with "Edited by" footer). Invoice editor has payment split (Cash/Online/Mixed) and edit mode; receipt editor has edit mode ("Edit" button on cards for admin). Collections already editable.
- **Duplicate-customer guard** in CustomerPicker "New customer" tab: searches DB by name (≥3 chars) or mobile (≥4 digits) and shows "Already in the database — tap to use".
- **Backup all data** (Reports screen, admin): `GET /api/admin/backup/token` → `backup.xlsx` (one sheet per collection, password hashes excluded) and `backup.json` (restore-ready, all collections).
- **Add Customer form**: now has Address and Note fields (`address` added to Customer model/create; stored on customer doc, reused by receipt/invoice auto-fill).
- **Sales admin edit/delete**: PATCH /api/sales/{id} now also accepts customer_name, customer_id, cash_amount/online_amount (amount = cash+online, mode auto), date_key (admin only). Sales screen: edit sheet has Customer, Payment (Cash/Online/Mixed), Sale date (admin), scrollable; a trash icon on each card (admin) + "Delete this sale" in the sheet. Delete confirm uses window.confirm on web (Alert.alert is a no-op on web — this was why admin "couldn't delete" in the browser).
- **Edit Customer**: tap a customer card (name area) on Home → `CustomerEditModal` (name, phone, address, note + "Open customer ledger"). `PATCH /api/customers/{id}` (any signed-in user; phone unique → 409; syncs customer_name/mobile on that customer's invoices, receipts and sales).

## Update — restore + UX fixes (Jun 2026, session 3)
- **Project restored** from uploaded archive into `/app`; env preview URLs + MONGO_URL kept for this container.
- **Daybook date navigator** fixed forward/back (UTC-safe `shiftDate` — was landing on same day in +offset TZs like IST).
- **Address mandatory for new customers** across Home Add Customer, Punch Sale (new address field), Receipts & Invoices (only when creating a new customer, i.e. no `customer_id`).
- **Workspace-wide customer search**: `GET /api/customers` lifts the `assigned_to` restriction when a `search` term is present, so any employee can find any customer by name/phone from the Home search bar; default (no search) still shows only their own list.
- **Customer Ledger details + edit**: ledger now shows a details card (name, mobile, address, note) with an Edit button (header + card) reusing `CustomerEditModal`.
- **Add Customer keyboard fix**: bottom sheet lifts above the keyboard via RN core `Keyboard` events + animated `marginBottom` (KeyboardAwareScrollView misbehaves inside RN Modal on Android).
- **Daybook combined sale figure**: breakdown card shows a highlighted **TOTAL SALE (SALES + INVOICES)** = `total_collection.sales + total_collection.invoices` with the split beneath. No double-count (Daybook sales already excludes invoice-linked sales).
- **Date-wise browsing on Sales / Invoices / Money Receipts**: new shared `src/components/DateNavigator.tsx` (prev / today / next, can't go future). Backend list endpoints accept optional `date=YYYY-MM-DD` (`/api/sales`, `/api/invoices`, `/api/receipts`) filtering by `date_key`. Frontend `listSales/listInvoices/listReceipts` take a `date` arg; each screen defaults to today and browses day-by-day.


## Update — Expo SDK 57 upgrade (Jun 2026, session 4)
- Upgraded Expo SDK 54 → **57** (`expo@57.0.20`, `react-native@0.86.3`, `react@19.2.3`) via `expo install expo@^57` + `expo install --fix`.
- **app.json**: removed `newArchEnabled` and `android.edgeToEdgeEnabled` (both are defaults from SDK 55+). `expo install --fix` auto-added config plugins (expo-font, expo-image, expo-secure-store, expo-status-bar, expo-web-browser).
- **Vector icons migrated** `@expo/vector-icons` → `@react-native-vector-icons/ionicons@13.1.3` (only Ionicons was used). All 28 screens/components now `import Ionicons from "@react-native-vector-icons/ionicons"`. Config plugin auto-added to app.json.
- **Expo Go icon-font prewarm** (`src/hooks/use-icon-fonts.ts`) updated: under Expo Go (StoreClient) it loads the Ionicons `.ttf` from jsDelivr for `@react-native-vector-icons/ionicons@13.1.3` registered under family key `Ionicons` (the postScriptName the component renders with); native builds + web pass an empty map. Preserves the Android-Expo-Go workaround for 0-byte Metro font assets.
- Verified: `expo-doctor` 20/20 passed, ESLint clean, web preview renders with all icons + navigation intact.
- NOTE: users testing on **Expo Go** must use an Expo Go build that supports SDK 57.

## Update — Daybook counts only receipted sales/invoices (Jun 2026, session 5)
- Rule: a sale or invoice contributes to Daybook cash/online totals ONLY when a money receipt has been generated against it (same-day linked receipt). Un-receipted sales/invoices are excluded from sale_totals, inv_totals, grand_total and expected_cash.
- Backend `_build_daybook`: each sale/invoice entry gets a `counted` flag (= has >=1 linked receipt); totals gated on it. Excel export uses the same function so exports match.
- Frontend daybook: un-receipted sale/invoice rows show a grey "NOT COUNTED" badge; breakdown hint updated to explain the rule.
- Verified end-to-end: a cash sale with no receipt => counted=false, sales total 0, not in grand/expected; after POST /api/receipts against it => counted=true, sales total + grand cash rise by the amount.
