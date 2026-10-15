# API Spec สำหรับ Load Test — pmc-line

> อ้างอิงโค้ด ณ 2026-10-12 (branch `main`) · ครอบคลุม route ทั้งหมด **24 ไฟล์ = 30 operations**
> เอกสารนี้เขียนให้ tester ใช้เขียนสคริปต์ load test (k6 / JMeter / locust) — ทุก field และทุก error message มาจากโค้ดจริง (`src/app/api/**` + `packages/core/src/schemas.ts`); ตัวอย่าง curl เส้นหลัก**รันยืนยันแล้ว**กับ dev server + emulator (login, สร้างออเดอร์, validate ทุกกรณี, admin orders ทุกโหมด, dashboard, status/note, slip, products CRUD + 409, discount codes ครบวงจร, upload, 403 ทุก role, 401, logout) — เส้น super-only ที่เหลืออ้างจากโค้ดที่ระบุไว้

---

## สารบัญ

- [0. ภาพรวมและกติกากลาง](#0-ภาพรวมและกติกากลาง)
- [1. เตรียมสภาพแวดล้อม + ข้อมูล (seed)](#1-เตรียมสภาพแวดล้อม--ข้อมูล-seed)
- [2. การยืนยันตัวตน (Auth)](#2-การยืนยันตัวตน-auth)
- [3. Endpoint Reference](#3-endpoint-reference)
  - [3.1 Public — ไม่ต้อง login (4)](#31-public--ไม่ต้อง-login-4)
  - [3.2 Login / Logout (2)](#32-login--logout-2)
  - [3.3 Admin — Orders (3)](#33-admin--orders-3)
  - [3.4 Admin — Dashboard stats (1)](#34-admin--dashboard-stats-1)
  - [3.5 Admin — Products (4)](#35-admin--products-4)
  - [3.6 Admin — Partners (4)](#36-admin--partners-4)
  - [3.7 Admin — Users (4)](#37-admin--users-4)
  - [3.8 Admin — Discount codes (4)](#38-admin--discount-codes-4)
  - [3.9 Admin — รูปภาพ / สลิป (4)](#39-admin--รูปภาพ--สลิป-4)
- [4. ภาคผนวก](#4-ภาคผนวก)

ตารางรวม 30 operations:

| List Load Test "1", "3", "7", "10", "11" |
| # | Method | Path | Auth | หมายเหตุ load test |
|---|--------|------|------|---------------------|
| 1 | POST | `/api/orders` | public | **เส้นหลัก** — multipart + อัปสลิป GCS + counters tx (hotspot) | 10TPS เส้น สั่งซื้อสินค้า
| 2 | POST | `/api/discount/validate` | public | เบา (2 bounded reads) — endpoint ไม่มี auth |
| 3 | GET | `/api/products` | public | cache 30s ในหน่วยความจำ — โหนดเบามาก | 50TPS เส้น list สินค้าฝั่ง Line OA
| 4 | GET | `/api/product-image/[fileId]` | public | binary + cache 1 ชม. (เมื่อใช้ proxy) |
| 5 | POST | `/api/admin/login` | public | **bcrypt cost 12 — ห้ามยิงเป็น throughput** |
| 6 | POST | `/api/admin/logout` | ไม่เช็ค | ลบ cookie, โหนดเบา |
| 7 | GET | `/api/admin/orders` | cookie | มีโหมด unbounded + `?q=` full-scan (หนัก) | 50TPS เส้น Admin Order
| 8 | PATCH | `/api/admin/orders/[orderId]/status` | cookie | เขียน 1 doc |
| 9 | PATCH | `/api/admin/orders/[orderId]/note` | cookie | เขียน 1 doc |
| 10 | GET | `/api/admin/dashboard-stats` | cookie | Firestore aggregation + cache 30s | 50TPS เส้น Admin Dashboard
| 11 | GET | `/api/admin/products` | cookie | cursor pagination หน้า 10 แถว | 10 TPS เส้น list สินค้าฝั่ง Admin 
| 12 | POST | `/api/admin/products` | cookie | เขียน 1 doc, 409 ถ้ารหัสซ้ำ |
| 13 | PUT | `/api/admin/products/[productCode]` | cookie | เขียน 1 doc |
| 14 | DELETE | `/api/admin/products/[productCode]` | cookie | ลบ 1 doc |
| 15 | GET | `/api/admin/partners` | cookie | อ่านสดทุกครั้ง (ไม่ cache) |
| 16 | POST | `/api/admin/partners` | SUPER_ADMIN | เขียน 1 doc |
| 17 | PUT | `/api/admin/partners/[id]` | SUPER_ADMIN | เขียน 1 doc |
| 18 | PATCH | `/api/admin/partners/[id]/active` | SUPER_ADMIN | สลับ isActive |
| 19 | GET | `/api/admin/users` | SUPER_ADMIN | อ่านทั้ง collection users |
| 20 | POST | `/api/admin/users` | SUPER_ADMIN | bcrypt hash + เขียน 1 doc |
| 21 | PUT | `/api/admin/users/[id]` | SUPER_ADMIN | bcrypt hash เมื่อส่ง password |
| 22 | PATCH | `/api/admin/users/[id]/active` | SUPER_ADMIN | สลับ isActive |
| 23 | GET | `/api/admin/discount-codes` | cookie | ต้องส่ง `?type=` |
| 24 | POST | `/api/admin/discount-codes` | cookie | promotion fan-out เขียน N docs + audit |
| 25 | PUT | `/api/admin/discount-codes/[code]` | cookie | ต้องส่ง `?type=` (+`?partner=` ถ้า promotion) |
| 26 | PATCH | `/api/admin/discount-codes/[code]/active` | cookie | เขียน + เขียน audit |
| 27 | GET | `/api/admin/slip/[fileId]` | cookie | **binary ดึงจาก GCS ทุกครั้ง — เส้นรูปที่หนักจริง** |
| 28 | POST | `/api/admin/upload/product-image` | cookie | อัปไฟล์ขึ้น GCS |
| 29 | DELETE | `/api/admin/upload/product-image` | cookie | ลบไฟล์ GCS |
| 30 | POST | `/api/admin/upload/qr-image` | SUPER_ADMIN | อัปไฟล์ขึ้น GCS |

---

## 0. ภาพรวมและกติกากลาง

### Base URL

| สภาพแวดล้อม | Base URL | หมายเหตุ |
|---|---|---|
| local dev (ใช้ในเอกสารนี้) | `http://localhost:3000` | `pnpm dev` — ต่อ Firestore emulator `localhost:8080` + fake GCS `localhost:4443` (ค่าใน `.env` ของ repo) |
| production (Vercel) | โดเมนที่ทีมใช้จริง | **ดูคำเตือนใน §1.4 ก่อนยิงทุกครั้ง** |

### รูปแบบ response กลาง

- **Mutation สำเร็จ**: `{ "success": true, ... }` (create จะมี `id` / `code` / `orderId` / `created` เพิ่ม)
- **Read สำเร็จ**: คืน payload ตรง ๆ ไม่มี field `success` เช่น `{ "orders": [...], "nextCursor": "...", "total": 42 }`
- **Error**: `{ "success": false, "error": "<ข้อความภาษาไทยหรืออังกฤษ>" }` — เส้นที่ validate ละเอียดจะแถม `fieldErrors: { "<field>": "<ข้อความ>" }`
- **ข้อยกเว้นเดียว**: `POST /api/discount/validate` ใช้รูปร่างของตัวเอง `{ "valid": false, "error": "...", "tone": "ok"|"error" }` และ**คืน HTTP 200 แม้รหัสไม่ผ่าน** (ดู §3.1)
- Validation ด้วย zod ทุกเส้น: body ผิดรูปจะได้ **400 พร้อมข้อความของ issue แรกตัวเดียว** (ไม่ไล่รายการทุก field)

### กติกาที่ tester ต้องรู้

1. **ไม่มี rate limit และไม่มี CSRF ป้องกันทุกเส้น** — แอปจะไม่คืน 429 เอ็นจินจึงต้องคุมยอดเอง ของธรรมชาติที่กดได้คือ quota ของ Firestore/GCS และ contention ภายใน
2. **Middleware ไม่คลุม `/api/*`** — middleware ป้องกันเฉพาะหน้า `/admin/:path*` (redirect 302) ทุก route `/api/admin/*` เช็ค cookie เองและคืน **401 JSON** ยิง API ตรง ๆ ได้เลยไม่ต้องผ่านหน้าเว็บ
3. **ค่าสถานะ/ข้อความเป็นสายอักขระไทย** — สถานะออเดอร์ 5 ค่า: `รอตรวจสอบสลิป`, `ยืนยันแล้ว`, `กำลังจัดส่ง`, `จัดส่งแล้ว`, `ยกเลิก` เวลาใส่ใน query string ให้ URL-encode (curl ใช้ `-G --data-urlencode` ได้เลยตามตัวอย่าง)
4. **Header กลางทุก response**: `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex` — ไม่มี header อื่นที่เกี่ยวกับความปลอดภัย/ควบคุมโหลด
5. **รูปแบบรหัสออเดอร์**: `{PARTNER}-{YYMM}-{NNNNNN}` — YYMM คือเดือนปัจจุบันตามเวลาไทย (ต.ค. 2026 = `2610`) เช่น `P01-2610-000091` — เลขต่อท้ายนับจาก Firestore transaction ต่อ `partner-เดือน` (ต่อจาก seed ที่มีอยู่ ไม่เริ่ม 1 ใหม่)

---

## 1. เตรียมสภาพแวดล้อม + ข้อมูล (seed)

### 1.1 สั่งเปิดและตรวจว่าพร้อม

```bash
pnpm emulators          # เปิด Firestore emulator (8080) + fake GCS (4443) — ถ้ายังไม่รัน
pnpm dev                # เปิดแอปที่ localhost:3000
curl -s http://localhost:3000/api/products | head -c 300   # ต้องได้ JSON {"products":[...
```

ค่า env ของ local (อยู่ใน `.env` ของ repo แล้ว): `FIRESTORE_EMULATOR_HOST=localhost:8080`, `GCS_EMULATOR_HOST=localhost:4443`, `GCS_BUCKET=demo-project`, `ADMIN_SESSION_SECRET=...`

### 1.2 บัญชีทดสอบ — `pnpm seed:users` (idempotent, ข้ามถ้ามีอยู่แล้ว)

| username | password | role | พาร์ทเนอร์ที่เห็น | ใช้ทดสอบ |
|---|---|---|---|---|
| `admin` | `admin123` | SUPER_ADMIN | ทุกพาร์ทเนอร์ | เส้น super-only (users/partners/referral) |
| `partneradmin` | `partner-pass-1` | PARTNER_ADMIN | `6TY` | เส้น scoped, เขียนได้ในขอบเขตตัวเอง |
| `partnerviewer` | `viewer-pass-1` | PARTNER_VIEWER | `6TY` | ต้อง **403 ทุกเส้นเขียน** |
| `multiadmin` | `multi-pass-1` | PARTNER_ADMIN | `6TY`, `ZZQ` | ทดสอบ query หลายพาร์ทเนอร์ (`in` query) |
| `inactiveuser` | `inactive-pass-1` | PARTNER_ADMIN | `6TY` | login ต้อง **401 เสมอ** (บัญชีถูกปิด) |

⚠️ บัญชีชุดนี้มีไว้สำหรับ **emulator/local เท่านั้น** — production มีชุดผู้ใช้จริงของตัวเองใน Firestore (ขอจากเจ้าของระบบ)

### 1.3 ชุดข้อมูลปริมาณมาก — `pnpm seed:perf`

สร้างข้อมูล deterministic (PRNG seed คงที่ รันครั้งไหนได้ชุดเดิม) สำหรับยิงโหลด:

| อะไร | ค่าเริ่มต้น | ปรับด้วย env |
|---|---|---|
| พาร์ทเนอร์ | 30 ร้าน รหัส `P01`–`P30` | `PERF_PARTNERS` |
| ผู้ใช้ | 30 (`perfadmin01` SUPER_ADMIN, `perfuser02`–`perfuser30` admin/viewer สลับกัน รหัสผ่าน `perf-pass` ทุกตัว) | `PERF_USERS` |
| สินค้า | 50–100 รายการ/ร้าน (~2,236 รวม) รหัสแบบ `P01-P001`, ราคา 25–350 | — |
| ออเดอร์ | **200,000** ใบ ย้อนหลัง 90 วัน ครบทั้ง 5 สถานะ | `PERF_ORDERS` |
| สลิป | ทุกใบชี้ไฟล์เดียวกันใน GCS `slips/perf-slip-seed.png` | `PERF_SLIP_FILE` |

-  emulator: `PERF_ORDERS=20000 pnpm seed:perf` — **ต้องตั้ง PERF_ORDERS เองทุกครั้งบน emulator และเลขต้องเล็ก** (emulator ไว้ smoke ไม่ใช่ 200k)
-  production: `PERF_SEED_TARGET=prod node packages/database/scripts/seed-perf.mjs` — **ปฏิเสธรันถ้ามีออเดอร์อยู่แล้ว** (ปลอดภัย by default)

### 1.4 คำเตือนก่อนยิง production

- `POST /api/orders` **สร้างออเดอร์จริง** + อัปสลิปเข้า GCS จริง + ผลักเลขรันนิ่งจริง — ห้ามยิงซ้ำเพื่อ "ลองดู" เด็ดขาด
- `POST /api/admin/login` เรียก bcrypt (cost 12) — ยิงถี่จะกิน CPU ของ serverless จริง ใช้เพียง setup ครั้งเดียวต่อ virtual user
- เส้นเขียนทั้งหมด (products/partners/users/discount-codes) แก้ข้อมูลจริง — ถ้าจะทดสอบเส้นเขียน ให้ทำบน emulator หรือ environment เฉพาะงาน ไม่ใช่ prod ที่มีข้อมูลลูกค้า

---

## 2. การยืนยันตัวตน (Auth)

- เข้าสู่ระบบด้วย `POST /api/admin/login` (§3.2) → ได้ cookie **`pmc_admin_session`** (httpOnly, SameSite=Lax, path=/, **หมดอายุ 12 ชั่วโมง**)
- ทุกเส้น `/api/admin/*` (ยกเว้น login/logout) เช็ค cookie นี้เอง — ไม่ผ่าน → `401 { "success": false, "error": "Unauthorized" }`
- ไม่ต้องมี CSRF token / header พิเศษอื่นใด — แนบ cookie เป็น header พอ:

```bash
BASE=http://localhost:3000
CJ=/tmp/pmc-cookies.txt                       # cookie jar เดียวใช้ได้ 12 ชม.

curl -s -c "$CJ" -X POST "$BASE/api/admin/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}'
# => 200 {"success":true,"name":"...","username":"admin"}

# จากนั้นทุกเส้น admin แค่เพิ่ม -b "$CJ"
curl -s -b "$CJ" "$BASE/api/admin/orders?limit=1"
```

### Role และขอบเขต (scoping) — เส้นไหนผ่าน/ไม่ผ่าน

| Role | อ่าน | เขียน | หมายเหตุ |
|---|---|---|---|
| SUPER_ADMIN | ทุกพาร์ทเนอร์ (ไม่ต้องส่ง `?partner=`) | ทุกเส้น | เส้น users / partners / referral codes เป็น super-only |
| PARTNER_ADMIN | เฉพาะพาร์ทเนอร์ใน `partnerRoles` ของตัวเอง | เขียนได้ในขอบเขตตัวเอง | ส่ง `?partner=` นอกขอบเขต → **403** |
| PARTNER_VIEWER | เหมือน PARTNER_ADMIN | **403 ทุกเส้นเขียน** | |

กติกา scoping ที่พบซ้ำในเส้น orders/dashboard/products: admin ที่ถูกผูกไว้ **0 พาร์ทเนอร์** จะได้ผลลัพธ์ว่าง (`{orders: []}` / `{orderCount:0,totalSales:0}`) ไม่ใช่ 403

### คำเตือนด้านโหลดของเส้น login

bcrypt verify ตั้งใจให้ช้า (~100ms+/ครั้ง กิน CPU) — **ห้าม**เอาไปวัด throughput หรือยิงรัว ให้ login ครั้งเดียวต่อ virtual user ใน setup phase แล้ว reuse cookie ตลอด 12 ชม. ถ้า cookie หมดกลางรัน ให้ระวังว่า 401 ที่เจอคือ "หมดเซสชัน" ไม่ใช่ "ระบบล่ม"

---

## 3. Endpoint Reference

รูปแบบตัวแปรในตัวอย่างทั้งหมด: `BASE=http://localhost:3000`, `CJ=/tmp/pmc-cookies.txt` (login แล้ว)

### 3.1 Public — ไม่ต้อง login (4)

---

#### 3.1.1 `POST /api/orders` — สร้างออเดอร์ (เส้นเขียนหลักของระบบ)

ไฟล์: `src/app/api/orders/route.ts`

- **Auth**: ไม่มี
- **Content-Type**: `multipart/form-data` (**ไม่ใช่ JSON**) — 2 fields:

| Field | ชนิด | เงื่อนไข |
|---|---|---|
| `payload` | string (JSON) ตามตารางล่าง | บังคับ |
| `slip` | File (JPG/PNG/WebP, ≤ 5 MB) | บังคับ**เมื่อ total ที่ server คำนวณได้ > 0** (สั่งของ ฿0 ไม่ต้องส่ง) |

โครง JSON ใน `payload` (schema `createOrderSchema` — `packages/core/src/schemas.ts:55`):

| Field | ชนิด/เงื่อนไข | บังคับ |
|---|---|---|
| `items` | array `{ id, qty }` 1–100 แถว, `qty` เป็นเลขจำนวนเต็ม 1–999, `id` = รหัสสินค้า | ✓ |
| `name` | string 1–120 | ✓ |
| `phone` | เลขไทย `^0\d{8,9}$` (ตัดช่องว่าง/ขีดให้ก่อน) — 9–10 หลักขึ้นต้น 0 | ✓ |
| `address` | ≤ 300 | ✓ |
| `subdistrict` / `district` / `province` | ≤ 120 ตัวอักษร | ✓ |
| `postalCode` | `^\d{5}$` | ✓ |
| `pdpaConsent` | boolean ต้องเป็น `true` | ✓ |
| `referralCode` | ตัวเลข ≤ 10 หลัก, ค่าเริ่มต้น `''` | — |
| `promotionCode` | `A-Z 0-9 _ -` ≤ 20 ตัว (ระบบ uppercase ให้), ค่าเริ่มต้น `''` | — |
| `note` | ≤ 500, ค่าเริ่มต้น `''` | — |
| `newsConsent` | boolean, ค่าเริ่มต้น `false` | — |
| `liffUserId` | ≤ 120, ค่าเริ่มต้น `''` | — |
| `subtotal` / `discount` / `shipping` / `total` | เลข ≥ 0 — **ระบบรับไว้แต่ทิ้งทันที** คำนวณใหม่จาก catalog ฝั่ง server เสมอ | ✓ (ตามรูปร่าง) |

พฤติกรรมฝั่ง server ที่ tester ต้องเข้าใจ:
- ราคา/ชื่อสินค้า อ่านจาก catalog จริง — ส่ง `price`/`name` มาเองไม่มีผล; `id` ไม่พบ → 400; ของหมด → 400; ตะกร้าคละหลายร้าน → 400
- โค้ดส่วนลดถูก resolve ใหม่จาก partnerCode ที่ server สรุปเอง + วันที่เวลาไทย (Asia/Bangkok) ของวินาทีนั้น
- อัปสลิปขึ้น GCS `slips/` ทุกใบ — ถ้าเขียน Firestore พังหลังอัป ไฟล์จะถูกลบทิ้ง
- **คอขวดโหลด**: การจอยเลขออเดอร์เขียนผ่าน transaction ลง doc เดียวต่อ `partner-เดือน` (`counters/{PARTNER-YYMM}`) — ยิงถี่เข้าพาร์ทเนอร์เดียวจะชนกันเอง (contention) ควรกระจายหลายพาร์ทเนอร์ถ้าเป้าคือวัด throughput สุทธิ

ตัวอย่างที่**รันยืนยันแล้ว** (เช็ครหัสสินค้า/ราคาจริงจาก `GET /api/products` ก่อน — ที่นี่ใช้ `P01-P001` ราคา 290฿ จากชุด seed-perf):

```bash
SLIP=packages/database/scripts/fixtures/perf-slip.png   # ไฟล์ fixture ใน repo (26 KB)

curl -s -X POST "$BASE/api/orders" \
  -F 'payload={"name":"ลูกค้า ทดสอบ","phone":"0812345678","address":"99 ถนนทดสอบ","subdistrict":"ทดสอบ","district":"เมืองทดสอบ","province":"กรุงเทพมหานคร","postalCode":"10000","items":[{"id":"P01-P001","qty":2}],"subtotal":580,"discount":0,"shipping":0,"total":580,"pdpaConsent":true,"referralCode":"","promotionCode":"","note":"","newsConsent":false,"liffUserId":""}' \
  -F "slip=@$SLIP;type=image/png"
# => 200 {"success":true,"orderId":"P01-2610-000091"}
```

| Status | เมื่อไหร่ | Body |
|---|---|---|
| 200 | สำเร็จ (**ไม่ใช่ 201**) | `{ "success": true, "orderId": "..." }` |
| 400 | formData พัง | `{ "success": false, "error": "Invalid form data" }` |
| 400 | `payload` ไม่ใช่ JSON | `{ "success": false, "error": "Invalid JSON" }` |
| 400 | zod ไม่ผ่าน (เช่น phone ผิด, pdpaConsent false) | `{ "success": false, "error": "<ข้อความไทยของ issue แรก>" }` |
| 400 | สินค้าหมด | `{ "success": false, "error": "สินค้าหมด: <ชื่อสินค้า>" }` |
| 400 | รหัสสินค้าไม่พบ/inactive | `{ "success": false, "error": "สินค้าไม่ถูกต้อง" }` |
| 400 | ตะกร้าหลายพาร์ทเนอร์ | `{ "success": false, "error": "ไม่สามารถสั่งสินค้าจากหลายพาร์ทเนอร์ในคำสั่งเดียวได้" }` |
| 400 | ไม่แนบสลิป (เมื่อ total > 0) | `{ "success": false, "error": "กรุณาแนบสลิปการโอนเงิน" }` |
| 400 | สลิปผิดชนิด/เกินขนาด | `"รองรับเฉพาะไฟล์ภาพ (JPG, PNG, WebP)"` หรือ `"ไฟล์ใหญ่เกิน 5 MB"` |
| 500 | อัปสลิปพัง | `{ "success": false, "error": "อัปโหลดสลิปไม่สำเร็จ กรุณาลองใหม่" }` |
| 500 | เขียน Firestore พัง | `{ "success": false, "error": "<ข้อความ repository>" }` |

---

#### 3.1.2 `POST /api/discount/validate` — เช็คโค้ดส่วนลดหน้าร้าน

ไฟล์: `src/app/api/discount/validate/route.ts` · **Auth: ไม่มี** (เส้นสาธารณะ — เป็นเป้ายิงได้ง่าย ควรอยู่ใน scenario เสมอ)

Body (JSON): `{ "code": "≤20 ตัวอักษร", "codeType": "referral" | "promotion", "partner": "≤40 ตัวอักษร (เช่น 6TY), ใช้แสดงผลเท่านั้น" }`

```bash
curl -s -X POST "$BASE/api/discount/validate" -H 'Content-Type: application/json' \
  -d '{"code":"1234","codeType":"referral","partner":"6TY"}'
# รหัสผ่าน  => 200 {"valid":true,"code":"1234","codeType":"referral","discountType":"AMOUNT","discountValue":20}
# รหัสไม่พบ => 200 {"valid":false,"error":"ไม่พบรหัสส่วนลดนี้","tone":"error"}
```

| Status | เมื่อไหร่ | Body |
|---|---|---|
| 200 | รหัสใช้ได้ | `{ "valid": true, "code", "codeType", "discountType": "AMOUNT"\|"PER_PACK"\|"PERCENT", "discountValue" }` |
| 200 | รหัสไม่ผ่าน (**HTTP ยัง 200**) | `{ "valid": false, "error": "<ข้อความไทย>", "tone": "error" \| "ok" }` — ข้อความที่เป็นไปได้: promotion ไม่พบ → `ไม่พบรหัสส่วนลดนี้`; **referral ไม่พบ → `บันทึกรหัสผู้แนะนำเรียบร้อย` + `tone:"ok"` (ถือว่าปกติ ไม่มีส่วนลด)**; ปิดใช้งาน → `รหัสส่วนลดนี้ถูกปิดใช้งานแล้ว`; ยังไม่เริ่ม → `รหัสส่วนลดนี้ยังไม่เริ่มใช้งาน`; หมดอายุ → `รหัสส่วนลดนี้หมดอายุแล้ว`; ร้านไม่ตรง → `รหัสส่วนลดนี้ใช้กับร้านนี้ไม่ได้`; กรอกผิดช่อง → `รหัสนี้เป็นรหัสโปรโมชั่น กรุณากรอกในช่องรหัสโปรโมชั่น` (หรือกลับกัน) |
| 400 | JSON/schema พัง | `{ "valid": false, "error": "รหัสส่วนลดไม่ถูกต้อง" }` |
| 500 | อ่าน Firestore พัง | `{ "valid": false, "error": "รหัสส่วนลดนี้ใช้งานไม่ได้" }` |

⚠️ tester ต้องนับ `valid:false` เป็น **สำเร็จระดับแอป** (HTTP 200) — อย่านับเป็น error rate ของระบบ

---

#### 3.1.3 `GET /api/products` — catalog หน้าร้าน

- **Auth**: ไม่มี · **Query**: `?partner=` (optional, กรองฝั่ง server ตาม partnerCode)

```bash
curl -s "$BASE/api/products?partner=6TY"
# => 200 {"products":[{"id":"6TY-1P520","partnerCode":"6TY","name":"1 PACK · 520ml","unit":"ต่อแพ็ค","price":139,"was":null,"badge":null,"pictureUrl":null,"active":true,"outOfStock":false,"sortOrder":3}, ...]}
```

- คืน `{ "products": [...] }` เรียงของพร้อมขายก่อน · 500 → `{ "products": [], "error": "..." }`
- **cache ในหน่วยความจำ 30 วินาที** — ยิงรัวกี่ครั้งก็โดน Firestore แค่ครั้งเดียวต่อ 30s ต่อ instance (เส้นนี้จึงวัดแรงเครื่องแอป ไม่ใช่ฐานข้อมูล)

---

#### 3.1.4 `GET /api/product-image/[fileId]` — รูปสินค้า/QR (binary)

- **Auth**: ไม่มี · **Query**: `?folder=qr-code-payment` เท่านั้นที่ยอม (อย่างอื่น → 400)
- 200 → bytes ของรูป + `Cache-Control: public, max-age=3600` · 400 → `Invalid file id` / `Invalid folder` · 404 → `Not found`
- ใน production รูปสินค้า/QR ปกติโหลด**ตรงจาก GCS URL แล้ว** (เส้นนี้เหลือไว้กับข้อมูลเก่าที่เก็บ `gs://`) ทดสอบเส้นนี้เมื่อไหร่รู้ว่ามันคือ "โหมดเก่า"

```bash
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$BASE/api/product-image/qr-1700000000-abcd1234.png?folder=qr-code-payment"
```

---

### 3.2 Login / Logout (2)

#### 3.2.1 `POST /api/admin/login`

Body: `{ "username": "...", "password": "..." }` (อย่างลับ 1 ตัวอักษรขึ้นไปทั้งคู่)

```bash
curl -s -c "$CJ" -X POST "$BASE/api/admin/login" -H 'Content-Type: application/json' \
  -d '{"username":"partneradmin","password":"partner-pass-1"}'
```

| Status | เมื่อไหร่ | Body |
|---|---|---|
| 200 | สำเร็จ — **ตั้ง cookie `pmc_admin_session`** | `{ "success": true, "name": "...", "username": "..." }` |
| 400 | JSON พัง / field ว่าง | `"คำขอไม่ถูกต้อง"` หรือ `"กรุณากรอกข้อมูลให้ครบ"` |
| 401 | รหัสผิด **หรือบัญชีถูกปิด (isActive=false)** | `"ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง"` — ข้อความเดียวกันทั้งสองกรณี |
| 401 | โครงสร้างการผูกพาร์ทเนอร์พัง | `"การผูกพาร์ทเนอร์ของบัญชีนี้ไม่ถูกต้อง กรุณาติดต่อผู้ดูแลระบบ"` |

#### 3.2.2 `POST /api/admin/logout`

ไม่เช็ค auth, ไม่มี body — ลบ cookie แล้วคืน `200 {"success":true}` เสมอ

---

### 3.3 Admin — Orders (3)

#### 3.3.1 `GET /api/admin/orders` — ลิสต์ออเดอร์ (เส้นอ่านหลักของ admin)

Query ทั้งหมด optional: `partner`, `limit`, `status`, `from`, `to`, `q`, `cursor`

| พารามิเตอร์ | เงื่อนไข |
|---|---|
| `partner` | รหัสพาร์ทเนอร์เดียว — ถ้าอยู่นอกขอบเขตของ session → **403** |
| `limit` | **สวิตช์เปิด pagination** — ไม่ส่ง = ดึง**ทั้งหมด**ตามเงื่อนไข (โหมด unbounded, ตอบแค่ `{orders}`); ส่ง = 1–100 (นอกช่วงถูก clamp, ค่าเริ่มต้น 10) และตอบ `{orders, nextCursor, total}` |
| `status` | ไทย 5 ค่าตาม §0 — ค่าอื่นถูก**เมียงทิ้งเงียบ ๆ** (ไม่ error) |
| `from` / `to` | `YYYY-MM-DD` (inclusive, เวลาไทย) |
| `q` | ค้น orderId/ชื่อ/เบอร์โทรแบบ contains — **อ่านทุกใบในขอบเขตก่อนกรองในหน่วยความจำ** (โหมดหนักสุด ควรแยก scenario) และตอบ `nextCursor: null` เสมอ |
| `cursor` | ค่า `nextCursor` ที่ได้มาส่งกลับเข้ามา (base64url ของ `[[createdAtMs, orderId]])` — ค่าทึบ ห้ามเดา/แต่ง |

```bash
# หน้าละ 10 กรองสถานะไทย (curl encode ให้เองด้วย -G --data-urlencode)
curl -s -b "$CJ" -G "$BASE/api/admin/orders" --data-urlencode "status=รอตรวจสอบสลิป" -d limit=10

# หน้าถัดไป
curl -s -b "$CJ" "$BASE/api/admin/orders?limit=10&cursor=<ค่าnextCursorที่ได้>"

# ค้นหา (โหมดหนัก)
curl -s -b "$CJ" -G "$BASE/api/admin/orders" -d limit=100 --data-urlencode "q=0812"
```

| Status | Body |
|---|---|
| 200 | `{ "orders": [...], "nextCursor": "..." \| null, "total": n }` (มี limit) หรือ `{ "orders": [...] }` (ไม่มี limit) — scoped 0 พาร์ทเนอร์ → `{ "orders": [] }` |
| 401 / 403 | `{"success":false,"error":"Unauthorized"}` / `"Forbidden"` |
| 500 | `{"success":false,"error":"<ข้อความ>"}` |

#### 3.3.2 `PATCH /api/admin/orders/[orderId]/status`

Body: `{ "status": "<ไทย 5 ค่า>", "trackingNumber": "<≤80 ตัวอักษร, ค่าเริ่มต้น ''>" }` — `trackingNumber` **บังคับเมื่อ status = `กำลังจัดส่ง` หรือ `จัดส่งแล้ว`**

```bash
curl -s -b "$CJ" -X PATCH "$BASE/api/admin/orders/P01-2610-000091/status" \
  -H 'Content-Type: application/json' \
  -d '{"status":"ยืนยันแล้ว","trackingNumber":""}'
```

| Status | เมื่อไหร่ |
|---|---|
| 200 | `{ "success": true }` |
| 400 | JSON พัง `"คำขอไม่ถูกต้อง"` / zod (เช่น ขาด trackingNumber) → ข้อความแรก |
| 401 | ไม่มี cookie |
| 403 | PARTNER_VIEWER หรือออเดอร์ไม่อยู่ในพาร์ทเนอร์ของตัวเอง |
| 404 | `Order not found: <orderId>` |

#### 3.3.3 `PATCH /api/admin/orders/[orderId]/note`

Body: `{ "adminNote": "<≤250 ตัวอักษร>" }` — กติกา 401/403/404 เหมือน 3.3.2 ทุกอย่าง · สำเร็จ `200 {"success":true}`

```bash
curl -s -b "$CJ" -X PATCH "$BASE/api/admin/orders/P01-2610-000091/note" \
  -H 'Content-Type: application/json' -d '{"adminNote":"ลูกค้าขอจัดส่งช่วงเย็น"}'
```

---

### 3.4 Admin — Dashboard stats (1)

#### 3.4.1 `GET /api/admin/dashboard-stats`

Query: `partner`, `from`, `to` (`YYYY-MM-DD`, ว่าง = ไม่จำกัด) — **ไม่มี** `status`

```bash
curl -s -b "$CJ" "$BASE/api/admin/dashboard-stats"
# => 200 {"orderCount":1234,"totalSales":567890}
```

- `orderCount` นับรวมที่ยกเลิก; `totalSales` รวมเฉพาะที่ไม่ยกเลิก
- scoping เหมือน orders (0 พาร์ทเนอร์ → `{orderCount:0,totalSales:0}`, partner นอกขอบเขต → 403)
- **cache 30 วินาทีต่อ key** ในหน่วยความจำ — ค่าที่เห็นอาจเก่าสุด 30s และยิงถี่ไม่เพิ่มโหลด Firestore
- ใช้ Firestore aggregation (นับ/รวมในฐานข้อมูล) — ไม่ดึง doc ทั้งหมด

---

### 3.5 Admin — Products (4)

#### 3.5.1 `GET /api/admin/products`

Query: `partner` (enforce ขอบเขตเหมือน orders), `q` (ค้น id/ชื่อ/รหัสร้าน/หน่วย — โหมด in-memory, `nextCursor` มาเป็น null), `cursor` · ขนาดหน้า**ตายตัว 10 แถว** (ห้ามส่ง limit)

```bash
curl -s -b "$CJ" "$BASE/api/admin/products?partner=P01"
# => 200 {"products":[...], "nextCursor":"...", "total":57}
```

#### 3.5.2 `POST /api/admin/products`

Body (`productCreateSchema`):

| Field | เงื่อนไข |
|---|---|
| `id` | รหัสสินค้า 2–60 ตัวอักษร — **doc id, ซ้ำ = 409** |
| `partnerCode` | 2–40 (PARTNER_ADMIN สร้างได้เฉพาะของตัวเอง → นอกขอบเขต 403) |
| `partnerName` | 1–120 |
| `name` | 1–120 |
| `price` | เลข ≥ 0 ทศนิยม ≤ 2 ตำแหน่ง |
| `unit`, `was`, `badge`, `pictureUrl`, `active`, `outOfStock`, `sortOrder` | optional (ค่าเริ่มต้น `''`/null/true/false/0) |

```bash
curl -s -b "$CJ" -X POST "$BASE/api/admin/products" -H 'Content-Type: application/json' \
  -d '{"id":"P01-TEST01","partnerCode":"P01","partnerName":"พาร์ทเนอร์ P01","name":"น้ำทดสอบ 1L","price":59.5}'
# => 201 {"success":true,"id":"P01-TEST01"}   |  ซ้ำ => 409 {"success":false,"error":"มีรหัสสินค้านี้อยู่แล้ว: P01-TEST01"}
```

#### 3.5.3 `PUT /api/admin/products/[productCode]`

Body: เหมือนข้างบนแต่ optional ทั้งหมด และ**ห้าม/ไม่รับ `id` กับ `partnerCode`** (ส่งมาจะถูกตัดทิ้ง — ย้ายร้านของสินค้าไม่ได้) · 404 → `Product not found: <code>` · สำเร็จ `200 {"success":true}`

#### 3.5.4 `DELETE /api/admin/products/[productCode]`

ไม่มี body · 200 `{"success":true}` / 404 เหมือนข้างบน · PARTNER_VIEWER → 403 ทั้งกลุ่มนี้

---

### 3.6 Admin — Partners (4)

#### 3.6.1 `GET /api/admin/partners` — อ่าน**ทุกพาร์ทเนอร์** (ไม่กรองตาม scope — ใช้ทำ dropdown) · อ่านสดไม่ cache

`200 {"partners":[...]}` · 401

#### 3.6.2 `POST /api/admin/partners` — **SUPER_ADMIN เท่านั้น** (403 ถ้า role อื่น)

Body: `{ "partnerCode": "1–20 ตัวพิมพ์ใหญ่/เลข/_/- (uppercase ให้เอง)", "name": "1–200", "qrImageUrl": "<optional, nullable>" }` · `201 {"success":true,"id":"<partnerCode>"}` · **409** ถ้ารหัสซ้ำ

#### 3.6.3 `PUT /api/admin/partners/[id]` — SUPER_ADMIN

Body optional: `{ "name", "qrImageUrl" }` · `[id]` คือ doc id ของพาร์ทเนอร์ · 404 ถ้าไม่พบ

#### 3.6.4 `PATCH /api/admin/partners/[id]/active` — SUPER_ADMIN

Body: `{ "isActive": true|false }` — **ไม่มี zod**: ส่งไม่ใช่ boolean → `400 {"success":false,"error":"isActive must be boolean"}`

ปิดพาร์ทเนอร์ = หายจาก promotion pool และหน้าร้าน

---

### 3.7 Admin — Users (4) — ทุกเส้น **SUPER_ADMIN เท่านั้น** (role อื่น 403)

#### 3.7.1 `GET /api/admin/users` → `200 {"users":[...]}` (ไม่มี password hash ใน response)

#### 3.7.2 `POST /api/admin/users`

| Field | เงื่อนไข |
|---|---|
| `username` | 3–50 ตัว, `^[a-z0-9_.@-]+$` (พิมพ์เล็ก/เลข/`_ - @ .`) |
| `name` | 1–200 |
| `password` | ≥ 8 ตัวอักษร (server bcrypt เสมอ — เส้นนี้กิน CPU) |
| `role` | `SUPER_ADMIN` \| `PARTNER_ADMIN` \| `PARTNER_VIEWER` |
| `partnerRoles` | object `{ "<partnerCode>": "PARTNER_ADMIN"|"PARTNER_VIEWER" }` — กฎผูก: SUPER ⇔ ว่าง, ไม่ใช่ super ต้องมี 1–30 ร้าน, ร้านเดียวห้ามสอง role |

`400 {"success":false,"error":"ไม่พบพาร์ทเนอร์: XX"}` ถ้ารหัสร้านไม่มีจริง · **409** username ซ้ำ · `201 {"success":true,"id":"<userId>"}`

#### 3.7.3 `PUT /api/admin/users/[id]`

Body optional: `{ "name", "password" (≥8), "partnerRoles" }` — **เปลี่ยน role ไม่ได้** (ส่งมาไม่มีผล) · 404 `User not found` · 400 ถ้า binding ผิดกับ role เดิม

#### 3.7.4 `PATCH /api/admin/users/[id]/active`

Body: `{ "isActive": boolean }` (manual check เหมือน 3.6.4) — ปิดบัญชีแล้ว login จะ 401 (ข้อความเดียวกับรหัสผ่านผิด)

---

### 3.8 Admin — Discount codes (4)

ประเภทโค้ด: `referral` (ตัวเลข ≤10 หลัก, เป็น global ไม่ผูกร้าน — จัดการโดย SUPER_ADMIN เท่านั้น) และ `promotion` (`A-Z0-9_-` ≤20, ผูกร้าน — identity คือ `code + partnerCode` ร้านคนละร้านใช้ชื่อเดียวกันได้)
สูตรส่วนลด `discountType`: `AMOUNT` (ลดเหมา), `PER_PACK` (ลดต่อแพ็ค × จำนวนแพ็ครวม), `PERCENT` (% ของยอด, ≤ 100)

#### 3.8.1 `GET /api/admin/discount-codes` — **บังคับส่ง `?type=referral|promotion`** (ไม่ส่ง → 400 `"type ไม่ถูกต้อง"`)

- `type=referral` → SUPER_ADMIN เท่านั้น (scoped → 403)
- `type=promotion` → scoped admin เห็นเฉพาะร้านของตัวเอง
- `200 {"codes":[...]}`

#### 3.8.2 `POST /api/admin/discount-codes` — PARTNER_VIEWER 403

ร่าง union ตาม `codeType` (ทุกแบบใช้ field กลาง: `discountType`, `discountValue` (≥0, ≤2 ตำแหน่ง), `validFrom` `YYYY-MM-DD`, `validTo` (`YYYY-MM-DD|''|null`), `isActive` default true):

```jsonc
// referral
{ "codeType":"referral", "code":"1234", "discountType":"AMOUNT", "discountValue":20,
  "validFrom":"2026-10-01", "validTo":"", "isActive":true }

// promotion — สร้างให้หลายร้านพร้อมกัน (fan-out, ได้ created = จำนวนแถว)
{ "codeType":"promotion", "code":"WELCOME10", "discountType":"PERCENT", "discountValue":10,
  "validFrom":"2026-10-01", "validTo":"2026-10-31", "conditions":"ลูกค้าใหม่เท่านั้น",
  "partnerCodes":["6TY","ZZQ"] }
```

เงื่อนไขพิเศษ: `validTo < validFrom` → 400; `PERCENT` > 100 → 400; promotion ที่มี `"*"` ใน partnerCodes → super ได้ 400 (`ห้ามสร้างโปรโมชั่นแบบทุกพาร์ทเนอร์ ให้เลือกพาร์ทเนอร์แทน`), scoped ได้ 403; ร้านเป้าหมายไม่ active/ไม่อยู่ในขอบเขต → 403; ชื่อซ้ำ → **409** + `fieldErrors` (ข้อความจริงที่รันยืนยัน: `{"error":"มีรหัสนี้อยู่แล้ว: 8888","fieldErrors":{"code":"มีรหัสนี้อยู่แล้ว: 8888"}}`)

สำเร็จ: `201 {"success":true,"code":"WELCOME10","created":2}` (referral ไม่มี `created`) · เขียนจริง N docs + เขียน `discount_audit` ต่อแถว (เส้นเขียนหนักสุดของกลุ่มนี้)

#### 3.8.3 `PUT /api/admin/discount-codes/[code]` — ระบุแถวให้ครบด้วย query

- **`?type=referral|promotion`** บังคับ; promotion ต้องส่ง **`&partner=<รหัสร้าน>`** ด้วย (referral ไม่ต้อง) — ขาด → 400
- Body optional ทั้งหมด: `{ "discountType", "discountValue", "validFrom", "validTo", "isActive", "conditions" }` — `code`/`codeType`/`partnerCode` ส่งมาจะถูกตัดทิ้ง
- ค่าตรวจกับแถวเดิม: สูตร/ค่าผิด → 400 `"ส่วนลดไม่ถูกต้อง"` + fieldErrors; ช่วงวันเพี้ยน → 400 `"ช่วงวันไม่ถูกต้อง"` · ไม่พบแถว → 404 `"ไม่พบรหัสส่วนลด: <code>"` · แก้เกินขอบเขต → 403

```bash
curl -s -b "$CJ" -X PUT "$BASE/api/admin/discount-codes/WELCOME10?type=promotion&partner=6TY" \
  -H 'Content-Type: application/json' -d '{"discountValue":15}'
```

#### 3.8.4 `PATCH /api/admin/discount-codes/[code]/active`

Query เหมือน 3.8.3 · Body: `{ "isActive": boolean }` · สำเร็จ 200 + เขียน audit (ACTIVATE/DEACTIVATE)

---

### 3.9 Admin — รูปภาพ / สลิป (4)

#### 3.9.1 `GET /api/admin/slip/[fileId]` — ภาพสลิป (binary)

- Auth: admin ทุก role (ไม่กรอง scope — admin คนไหนก็อ่านสลิปได้ทุกใบ)
- 200 bytes + `Cache-Control: private, max-age=3600` · 400 `Invalid file id` · 401 · 404 `Not found`
- **ดึงจาก GCS จริงทุกครั้งที่ miss cache ของ browser** — นี่คือเส้นรูปที่หนักจริง ควรอยู่ใน scenario เสมอ (สลิป seed ของชุด perf คือ `slips/perf-slip-seed.png` → fileId `perf-slip-seed.png`)

```bash
curl -s -b "$CJ" -o /dev/null -w '%{http_code} %{size_download} bytes\n' "$BASE/api/admin/slip/perf-slip-seed.png"
```

#### 3.9.2 `POST /api/admin/upload/product-image` — multipart, field **`image`**

- Auth: admin ทุก role · ไฟล์ **JPG/PNG เท่านั้น** (ไม่รับ WebP — ต่างจากสลิป!), ≤ 5 MB
- 200 `{"success":true,"url":"https://storage.googleapis.com/<bucket>/products/<fileId>","fileId":"<fileId>"}` (local: URL ชี้ fake-gcs)
- 400 `"Invalid form data"` / `"No file uploaded"` / `"รองรับเฉพาะไฟล์ภาพ JPG และ PNG"` / `"ไฟล์ใหญ่เกิน 5 MB"` · 500 `"อัปโหลดไม่สำเร็จ กรุณาลองใหม่"`

```bash
curl -s -b "$CJ" -X POST "$BASE/api/admin/upload/product-image" -F "image=@packages/database/scripts/fixtures/perf-slip.png;type=image/png"
```

#### 3.9.3 `DELETE /api/admin/upload/product-image?fileId=<fileId>` — ลบรูปที่อัปไว้

200 `{"success":true}` · 400 `Invalid file id` · 404 `Not found` (ไฟล์ไม่มีอยู่แล้ว)

#### 3.9.4 `POST /api/admin/upload/qr-image` — **SUPER_ADMIN เท่านั้น** (403)

multipart field `image` กติกาไฟล์เหมือน 3.9.2 เก็บไป `qr-code-payment/` · 200 `{"success":true,"url":"...","fileId":"..."}`

---

## 4. ภาคผนวก

### 4.1 ค่าคงที่ที่ใช้บ่อย

| ค่า | ที่มา |
|---|---|
| สลิป: JPG/PNG/WebP, ≤ 5 MB | `packages/core/src/slip.ts` |
| รูปสินค้า/QR: JPG/PNG เท่านั้น, ≤ 5 MB | `packages/core/src/product-image.ts` |
| ตะกร้า: 1–100 แถว, qty ต่อแถว 1–999 | `MAX_CART_LINES`, `MAX_ITEM_QTY` (`packages/core/src/pricing.ts`) |
| ค่าส่งคงที่ = 0 | `SHIPPING` (`packages/core/src/pricing.ts`) |
| หน้า products admin = 10 แถวตายตัว; orders กำหนดเองได้ 1–100 | `ADMIN_PAGE_SIZE` (`packages/core/src/pagination.ts`) |
| cache: products 30s, partners 60s, dashboard-stats 30s | `packages/database/src/reference-data-cache.ts` |
| cookie session 12 ชม. | `src/lib/session.ts` |

### 4.2 สินค้า 6TY ใน catalog ค่าคงที่ (`@pmc/core` — ใช้ในเทสต์; หน้าร้านอ่านจาก Firestore เสมอ)

⚠️ บน emulator สินค้าที่มีจริงคือชุด seed-perf (`P01-P001` …) — ตาราง 6TY นี้เป็นค่าคงที่ในโค้ด อย่าสมมติว่ามีในฐานข้อมูล **เช็คทุกครั้งด้วย `GET /api/products`**

| id | ชื่อ | ราคา (฿) |
|---|---|---|
| `6TY-3P520` | 3 PACK · 520ml | 327 |
| `6TY-3P1250` | 3 PACK · 1,250ml | 327 |
| `6TY-1P520` | 1 PACK · 520ml | 139 |
| `6TY-1P1250` | 1 PACK · 1,250ml | 139 |
| `6TY-6P750` | 6 PACK · 750ml AQUA+ | 599 |
| `6TY-3P350` | 3 PACK · 350ml KIDS | 245 |

(ชุด seed-perf มีสินค้า `P01-P001` แบบนี้อีก ~2,236 รายการ — เช็คราคาจริงจาก `GET /api/products?partner=P01`)

### 4.3 สถานะออเดอร์ (ไทย — ใช้ตรง ๆ ทั้งใน body และ `?status=`)

`รอตรวจสอบสลิป` → `ยืนยันแล้ว` → `กำลังจัดส่ง` → `จัดส่งแล้ว` (+ `ยกเลิก` ได้ทุกขั้น) — ออเดอร์ใหม่เริ่มที่ `รอตรวจสอบสลิป` เสมอ; trackingNumber บังคับเฉพาะ `กำลังจัดส่ง`/`จัดส่งแล้ว`; `ยกเลิก` ไม่ถูกนับใน `totalSales`

### 4.4 Gotchas ที่ tester พลาดบ่อย

1. **`POST /api/orders` สำเร็จคือ HTTP 200 ไม่ใช่ 201** (เส้น admin create ใช้ 201 — อย่าสับสนข้ามเส้น)
2. **`valid:false` ของ discount/validate คือ 200** — จัดเป็นเคสธุรกิจปกติ ไม่ใช่ error
3. ส่ง `status` ไทยใน query โดยไม่ encode → ค่าจะถูกเมียงทิ้งเงียบ ๆ (ได้ลิสต์ทุกสถานะแทนที่จะกรอง) ใช้ `curl -G --data-urlencode` หรือ encode เองให้ครบ
4. 400 จาก zod ให้**ข้อความเดียว (issue แรก)** — อย่าเขียน assertion คาดว่าจะเห็น error ครบทุก field
5. `inactiveuser` login ตอบ 401 พร้อมข้อความ**เดียวกับรหัสผ่านผิด** — ใช้แยกเคสไม่ได้จากภายนอก
6. โหมด `GET /api/admin/orders` **ไม่ส่ง limit** และโหมด `?q=` เป็น read แบบ unbounded — ถ้าเป้าหมายคือจำลอง UI ปกติ ให้ใช้ `limit=10` + cursor; เส้น heavy เหล่านี้แยก scenario ต่างหากและระบุชัดในรายงาน
7. 401 กลางรัน = cookie 12 ชม. หมดหรือ login ไม่ผ่าน ไม่ใช่สัญญาณระบบล่ม — login ใหม่แล้วประกาศในรายงานว่าเกิดขึ้นกี่ครั้ง
8. เส้น write ที่ตรวจ "มีอยู่จริงไหม" ก่อนเขียน (เช่น PUT product) จะอ่าน doc ก่อนเขียนเสมอ — นับเป็น 2 ops ต่อ request ตอนประเมินโหลด Firestore
