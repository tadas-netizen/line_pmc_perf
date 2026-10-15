#!/usr/bin/env python3
"""Local mock of the pmc-line API the k6 scripts call — for dry-running the scripts (smoke, check,
every load scenario) without the real app. Every route, status and message follows
docs/api-spec-loadtest.md (the 30 operations): cookie auth with the three roles and partner scoping,
zod-style first-issue 400s, 409 on duplicates, Thai statuses, cursor paging, the discount validator's
own shape, multipart orders with a slip, the per-partner-month order counter.

  python3 scripts/mock_line.py 18090 [latency_ms]
  PERF_BASE=http://127.0.0.1:18090 PERF_SMOKE_SECTIONS=all PERF_DEBUG=1 k6 run scenarios/smoke.js

Env: MOCK_ORDERS (2000 seeded orders) · MOCK_BCRYPT_MS (60: the login's fake hashing time) ·
     MOCK_ERROR_RATE (0..1: that share of /api calls fail — half as the app's 500 envelope, half as a
     Vercel 504 FUNCTION_INVOCATION_TIMEOUT page — to rehearse the error reporting)
A pass here proves the SCRIPT (request order, bodies, parsing, checks), not the app.
"""
import base64, json, os, random, re, sys, threading, time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

LATENCY = (int(sys.argv[2]) if len(sys.argv) > 2 else 20) / 1000
BCRYPT = int(os.environ.get("MOCK_BCRYPT_MS", "60") or 0) / 1000
ERROR_RATE = float(os.environ.get("MOCK_ERROR_RATE", "0") or 0)
ICT = timezone(timedelta(hours=7))
LOCK = threading.Lock()
rnd = random.Random(42)

STATUSES = ["รอตรวจสอบสลิป", "ยืนยันแล้ว", "กำลังจัดส่ง", "จัดส่งแล้ว", "ยกเลิก"]
NEEDS_TRACKING = {"กำลังจัดส่ง", "จัดส่งแล้ว"}

# ---- seed (docs §1.2 / §1.3, scaled down) ----------------------------------------------------
PARTNERS = {}
for i in range(1, 6):
    PARTNERS["P%02d" % i] = {"id": "P%02d" % i, "partnerCode": "P%02d" % i, "name": "พาร์ทเนอร์ P%02d" % i, "qrImageUrl": None, "isActive": True}
for code in ("6TY", "ZZQ"):
    PARTNERS[code] = {"id": code, "partnerCode": code, "name": "ร้าน " + code, "qrImageUrl": None, "isActive": True}
PRODUCTS = {}
for p in list(PARTNERS):
    for k in range(1, 9):
        pid = f"{p}-P{k:03d}"
        PRODUCTS[pid] = {"id": pid, "partnerCode": p, "partnerName": PARTNERS[p]["name"], "name": f"น้ำดื่ม {p} แบบ {k}", "unit": "ต่อแพ็ค",
                         "price": 25 + 5 * k, "was": None, "badge": None, "pictureUrl": None, "active": k != 8, "outOfStock": k == 7, "sortOrder": k}
USERS = {
    "admin": {"id": "u-admin", "username": "admin", "password": "admin123", "name": "Super Admin", "role": "SUPER_ADMIN", "partnerRoles": {}, "isActive": True},
    "partneradmin": {"id": "u-pa", "username": "partneradmin", "password": "partner-pass-1", "name": "Partner Admin", "role": "PARTNER_ADMIN", "partnerRoles": {"6TY": "PARTNER_ADMIN"}, "isActive": True},
    "partnerviewer": {"id": "u-pv", "username": "partnerviewer", "password": "viewer-pass-1", "name": "Partner Viewer", "role": "PARTNER_VIEWER", "partnerRoles": {"6TY": "PARTNER_VIEWER"}, "isActive": True},
    "multiadmin": {"id": "u-ma", "username": "multiadmin", "password": "multi-pass-1", "name": "Multi Admin", "role": "PARTNER_ADMIN", "partnerRoles": {"6TY": "PARTNER_ADMIN", "ZZQ": "PARTNER_ADMIN"}, "isActive": True},
    "inactiveuser": {"id": "u-in", "username": "inactiveuser", "password": "inactive-pass-1", "name": "Inactive", "role": "PARTNER_ADMIN", "partnerRoles": {"6TY": "PARTNER_ADMIN"}, "isActive": False},
    "perfadmin01": {"id": "u-perf01", "username": "perfadmin01", "password": "perf-pass", "name": "Perf Super Admin 01", "role": "SUPER_ADMIN", "partnerRoles": {}, "isActive": True},
    "perfuser02": {"id": "u-perf02", "username": "perfuser02", "password": "perf-pass", "name": "Perf User 02", "role": "PARTNER_ADMIN", "partnerRoles": {p: "PARTNER_ADMIN" for p in ("P01", "P02", "P03", "P04")}, "isActive": True},
    "perfuser03": {"id": "u-perf03", "username": "perfuser03", "password": "perf-pass", "name": "Perf User 03", "role": "PARTNER_VIEWER", "partnerRoles": {p: "PARTNER_VIEWER" for p in ("P01", "P02", "P03", "P04")}, "isActive": True},
}
DISCOUNTS = {  # key: (type, code, partner) — referral is global ('' partner)
    ("referral", "1234", ""): {"codeType": "referral", "code": "1234", "partnerCode": None, "discountType": "AMOUNT", "discountValue": 20, "validFrom": "2026-01-01", "validTo": "", "isActive": True},
}
for p in ("6TY", "P01"):
    DISCOUNTS[("promotion", "WELCOME10", p)] = {"codeType": "promotion", "code": "WELCOME10", "partnerCode": p, "discountType": "PERCENT", "discountValue": 10, "validFrom": "2026-01-01", "validTo": "", "isActive": True, "conditions": "ลูกค้าใหม่"}
AUDIT = []
COUNTERS = {}
ORDERS = {}
GCS = {"slips/perf-slip-seed.png"}
SESSIONS = {}
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")

def now_ict():
    return datetime.now(ICT)

def seed_orders(n):
    partners = list(PARTNERS)
    t0 = now_ict() - timedelta(days=90)
    for k in range(n):
        p = partners[k % len(partners)]
        created = t0 + timedelta(seconds=rnd.randint(0, 90 * 86400))
        yymm = created.strftime("%y%m")
        COUNTERS[f"{p}-{yymm}"] = COUNTERS.get(f"{p}-{yymm}", 0) + 1
        oid = f"{p}-{yymm}-{COUNTERS[f'{p}-{yymm}']:06d}"
        items = [{"id": f"{p}-P{rnd.randint(1, 6):03d}", "qty": rnd.randint(1, 3)}]
        total = sum(PRODUCTS[i["id"]]["price"] * i["qty"] for i in items)
        ORDERS[oid] = {"orderId": oid, "partnerCode": p, "status": rnd.choice(STATUSES), "name": f"ลูกค้า {k}", "phone": "08%08d" % rnd.randint(0, 99999999),
                       "items": items, "subtotal": total, "discount": 0, "shipping": 0, "total": total, "slipFileId": "perf-slip-seed.png",
                       "adminNote": "", "trackingNumber": "", "createdAt": created.isoformat(), "createdAtMs": int(created.timestamp() * 1000)}
seed_orders(int(os.environ.get("MOCK_ORDERS", "2000") or 0))

# ---- helpers ---------------------------------------------------------------------------------
def b64url(obj):
    return base64.urlsafe_b64encode(json.dumps(obj, separators=(",", ":")).encode()).decode().rstrip("=")

def unb64url(s):
    try:
        return json.loads(base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)).decode())
    except Exception:
        return None

def ict_day(ms):
    return datetime.fromtimestamp(ms / 1000, ICT).strftime("%Y-%m-%d")

def parse_multipart(ctype, body):
    """{name: (filename, content_type, bytes)} — enough for payload + slip / image."""
    m = re.search(r'boundary="?([^";]+)"?', ctype or "")
    if not m:
        return None
    out = {}
    delim = b"--" + m.group(1).encode()
    for part in body.split(delim)[1:]:
        if part.startswith(b"--"):
            break
        part = part[2:] if part.startswith(b"\r\n") else part
        if b"\r\n\r\n" not in part:
            continue
        head, data = part.split(b"\r\n\r\n", 1)
        if data.endswith(b"\r\n"):
            data = data[:-2]
        hd = head.decode("utf-8", "replace")
        nm = re.search(r'name="([^"]*)"', hd)
        fn = re.search(r'filename="([^"]*)"', hd)
        ct = re.search(r"Content-Type:\s*([^\r\n]+)", hd, re.I)
        if nm:
            out[nm.group(1)] = (fn.group(1) if fn else None, ct.group(1).strip() if ct else None, data)
    return out

def scoped(user):
    """partner codes a non-super user may see; None = all."""
    return None if user["role"] == "SUPER_ADMIN" else sorted(user["partnerRoles"])

def can_write(user):
    return user["role"] in ("SUPER_ADMIN", "PARTNER_ADMIN")

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass

    # ---- plumbing ----
    def send(self, code, body=None, headers=None, raw=None, ctype="application/json"):
        b = raw if raw is not None else (json.dumps(body, ensure_ascii=False).encode() if body is not None else b"")
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet, noimageindex")
        self.send_header("x-vercel-id", "mock::1")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def fail(self, code, msg, extra=None):
        d = {"success": False, "error": msg}
        if extra: d.update(extra)
        return self.send(code, d)
    def body(self):
        # read once and cache: a route that answers before reading (401 / 403) must still drain the
        # request body, or the leftover bytes corrupt the next request on this keep-alive connection
        if getattr(self, "_raw", None) is None:
            n = int(self.headers.get("content-length") or 0); self._raw = self.rfile.read(n) if n else b""
        return self._raw
    def json_body(self):
        try:
            return json.loads(self.body().decode() or "{}")
        except Exception:
            return None
    def cookie(self, name):
        m = re.search(r"(?:^|;\s*)" + name + r"=([^;]+)", self.headers.get("cookie") or ""); return m and m.group(1)
    def user(self):
        return SESSIONS.get(self.cookie("pmc_admin_session") or "")

    def do_GET(self): self.route("GET")
    def do_POST(self): self.route("POST")
    def do_PUT(self): self.route("PUT")
    def do_PATCH(self): self.route("PATCH")
    def do_DELETE(self): self.route("DELETE")

    def route(self, m):
        self._raw = None
        self.body()
        time.sleep(LATENCY)
        u = urlparse(self.path); p = u.path; q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if ERROR_RATE and p.startswith("/api/") and rnd.random() < ERROR_RATE:
            if rnd.random() < 0.5:
                return self.fail(500, "mock: injected Firestore failure")
            return self.send(504, raw=b"An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT", ctype="text/plain",
                             headers={"x-vercel-error": "FUNCTION_INVOCATION_TIMEOUT"})
        try:
            if p == "/healthz": return self.send(200, {"ok": True, "orders": len(ORDERS)})
            if p == "/api/products" and m == "GET": return self.products(q)
            if p.startswith("/api/product-image/") and m == "GET": return self.product_image(p, q)
            if p == "/api/discount/validate" and m == "POST": return self.validate()
            if p == "/api/orders" and m == "POST": return self.create_order()
            if p == "/api/admin/login" and m == "POST": return self.login()
            if p == "/api/admin/logout" and m == "POST":
                return self.send(200, {"success": True}, {"Set-Cookie": "pmc_admin_session=; Path=/; Max-Age=0"})
            if p.startswith("/api/admin/"):
                user = self.user()
                if not user: return self.fail(401, "Unauthorized")
                return self.admin(m, p, q, user)
            return self.fail(404, "Not found")
        except Exception as e:  # a bug in the mock, not the script
            return self.fail(500, f"mock error: {e!r}")

    # ---- public ----
    def products(self, q):
        rows = [x for x in PRODUCTS.values() if x["active"] and (not q.get("partner") or x["partnerCode"] == q["partner"])]
        rows.sort(key=lambda x: (x["outOfStock"], x["partnerCode"], x["sortOrder"]))
        return self.send(200, {"products": rows})

    def product_image(self, p, q):
        fid = unquote(p[len("/api/product-image/"):])
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", fid): return self.send(400, raw=b"Invalid file id", ctype="text/plain")
        folder = q.get("folder")
        if folder not in (None, "qr-code-payment"): return self.send(400, raw=b"Invalid folder", ctype="text/plain")
        key = f"{folder or 'products'}/{fid}"
        if key not in GCS and not fid.startswith("qr-"): return self.send(404, raw=b"Not found", ctype="text/plain")
        return self.send(200, raw=PNG, ctype="image/png", headers={"Cache-Control": "public, max-age=3600"})

    def validate(self):
        j = self.json_body()
        if not isinstance(j, dict) or not isinstance(j.get("code"), str) or j.get("codeType") not in ("referral", "promotion") or len(j.get("code", "")) > 20:
            return self.send(400, {"valid": False, "error": "รหัสส่วนลดไม่ถูกต้อง"})
        code, ct, partner = j["code"].strip().upper(), j["codeType"], j.get("partner") or ""
        other = DISCOUNTS.get(("promotion" if ct == "referral" else "referral", code, partner if ct == "referral" else ""))
        if ct == "referral":
            d = DISCOUNTS.get(("referral", code, ""))
            if not d:
                if other: return self.send(200, {"valid": False, "error": "รหัสนี้เป็นรหัสโปรโมชั่น กรุณากรอกในช่องรหัสโปรโมชั่น", "tone": "error"})
                return self.send(200, {"valid": False, "error": "บันทึกรหัสผู้แนะนำเรียบร้อย", "tone": "ok"})
        else:
            d = DISCOUNTS.get(("promotion", code, partner))
            if not d:
                if any(k[0] == "promotion" and k[1] == code for k in DISCOUNTS): return self.send(200, {"valid": False, "error": "รหัสส่วนลดนี้ใช้กับร้านนี้ไม่ได้", "tone": "error"})
                if DISCOUNTS.get(("referral", code, "")): return self.send(200, {"valid": False, "error": "รหัสนี้เป็นรหัสผู้แนะนำ กรุณากรอกในช่องรหัสผู้แนะนำ", "tone": "error"})
                return self.send(200, {"valid": False, "error": "ไม่พบรหัสส่วนลดนี้", "tone": "error"})
        if not d["isActive"]: return self.send(200, {"valid": False, "error": "รหัสส่วนลดนี้ถูกปิดใช้งานแล้ว", "tone": "error"})
        today = now_ict().strftime("%Y-%m-%d")
        if d["validFrom"] and today < d["validFrom"]: return self.send(200, {"valid": False, "error": "รหัสส่วนลดนี้ยังไม่เริ่มใช้งาน", "tone": "error"})
        if d["validTo"] and today > d["validTo"]: return self.send(200, {"valid": False, "error": "รหัสส่วนลดนี้หมดอายุแล้ว", "tone": "error"})
        return self.send(200, {"valid": True, "code": code, "codeType": ct, "discountType": d["discountType"], "discountValue": d["discountValue"]})

    def create_order(self):
        parts = parse_multipart(self.headers.get("content-type"), self.body())
        if parts is None or "payload" not in parts: return self.fail(400, "Invalid form data")
        try:
            j = json.loads(parts["payload"][2].decode())
        except Exception:
            return self.fail(400, "Invalid JSON")
        # createOrderSchema — the first issue only (docs §3.1.1)
        items = j.get("items")
        if not isinstance(items, list) or not 1 <= len(items) <= 100: return self.fail(400, "กรุณาเลือกสินค้า 1–100 รายการ")
        for it in items:
            if not isinstance(it, dict) or not isinstance(it.get("id"), str) or not isinstance(it.get("qty"), int) or not 1 <= it["qty"] <= 999:
                return self.fail(400, "จำนวนสินค้าต้องเป็น 1–999")
        if not isinstance(j.get("name"), str) or not 1 <= len(j["name"]) <= 120: return self.fail(400, "กรุณากรอกชื่อ")
        phone = re.sub(r"[\s-]", "", str(j.get("phone", "")))
        if not re.fullmatch(r"0\d{8,9}", phone): return self.fail(400, "เบอร์โทรไม่ถูกต้อง")
        for f, mx in (("address", 300), ("subdistrict", 120), ("district", 120), ("province", 120)):
            if not isinstance(j.get(f), str) or not 1 <= len(j[f]) <= mx: return self.fail(400, f"กรุณากรอก {f}")
        if not re.fullmatch(r"\d{5}", str(j.get("postalCode", ""))): return self.fail(400, "รหัสไปรษณีย์ไม่ถูกต้อง")
        if j.get("pdpaConsent") is not True: return self.fail(400, "กรุณายอมรับนโยบายความเป็นส่วนตัว")
        if j.get("referralCode", "") and not re.fullmatch(r"\d{1,10}", str(j["referralCode"])): return self.fail(400, "รหัสผู้แนะนำไม่ถูกต้อง")
        for f in ("subtotal", "discount", "shipping", "total"):
            if not isinstance(j.get(f), (int, float)) or j[f] < 0: return self.fail(400, f"{f} ไม่ถูกต้อง")
        partners = set()
        total = 0
        for it in items:
            pr = PRODUCTS.get(it["id"])
            if not pr or not pr["active"]: return self.fail(400, "สินค้าไม่ถูกต้อง")
            if pr["outOfStock"]: return self.fail(400, f"สินค้าหมด: {pr['name']}")
            partners.add(pr["partnerCode"]); total += pr["price"] * it["qty"]
        if len(partners) > 1: return self.fail(400, "ไม่สามารถสั่งสินค้าจากหลายพาร์ทเนอร์ในคำสั่งเดียวได้")
        partner = partners.pop()
        slip = parts.get("slip")
        if total > 0:
            if not slip or not slip[0]: return self.fail(400, "กรุณาแนบสลิปการโอนเงิน")
            if slip[1] not in ("image/jpeg", "image/png", "image/webp"): return self.fail(400, "รองรับเฉพาะไฟล์ภาพ (JPG, PNG, WebP)")
            if len(slip[2]) > 5 * 1024 * 1024: return self.fail(400, "ไฟล์ใหญ่เกิน 5 MB")
        with LOCK:  # counters/{PARTNER-YYMM} transaction
            yymm = now_ict().strftime("%y%m")
            COUNTERS[f"{partner}-{yymm}"] = COUNTERS.get(f"{partner}-{yymm}", 0) + 1
            oid = f"{partner}-{yymm}-{COUNTERS[f'{partner}-{yymm}']:06d}"
            fid = f"{oid}.png" if slip else ""
            if slip: GCS.add(f"slips/{fid}")
            t = now_ict()
            ORDERS[oid] = {"orderId": oid, "partnerCode": partner, "status": STATUSES[0], "name": j["name"], "phone": phone, "items": items,
                           "subtotal": total, "discount": 0, "shipping": 0, "total": total, "slipFileId": fid, "adminNote": "", "trackingNumber": "",
                           "createdAt": t.isoformat(), "createdAtMs": int(t.timestamp() * 1000)}
        return self.send(200, {"success": True, "orderId": oid})

    # ---- auth ----
    def login(self):
        j = self.json_body()
        if not isinstance(j, dict): return self.fail(400, "คำขอไม่ถูกต้อง")
        if not j.get("username") or not j.get("password"): return self.fail(400, "กรุณากรอกข้อมูลให้ครบ")
        time.sleep(BCRYPT)  # bcrypt cost 12
        u = USERS.get(j["username"])
        if not u or u["password"] != j["password"] or not u["isActive"]: return self.fail(401, "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง")
        sid = base64.urlsafe_b64encode(os.urandom(24)).decode().rstrip("=")
        with LOCK:
            SESSIONS[sid] = u
            if len(SESSIONS) > 50000:
                for k in list(SESSIONS)[:10000]: SESSIONS.pop(k, None)
        return self.send(200, {"success": True, "name": u["name"], "username": u["username"]},
                         {"Set-Cookie": f"pmc_admin_session={sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200"})

    # ---- admin ----
    def admin(self, m, p, q, user):
        scope = scoped(user)
        def partner_ok(code):
            return scope is None or code in scope
        # orders
        if p == "/api/admin/orders" and m == "GET":
            if q.get("partner") and not partner_ok(q["partner"]): return self.fail(403, "Forbidden")
            codes = [q["partner"]] if q.get("partner") else scope
            if codes is not None and not codes: return self.send(200, {"orders": []})
            rows = [o for o in ORDERS.values() if codes is None or o["partnerCode"] in codes]
            if q.get("status") in STATUSES: rows = [o for o in rows if o["status"] == q["status"]]
            if q.get("from"): rows = [o for o in rows if ict_day(o["createdAtMs"]) >= q["from"]]
            if q.get("to"): rows = [o for o in rows if ict_day(o["createdAtMs"]) <= q["to"]]
            rows.sort(key=lambda o: (-o["createdAtMs"], o["orderId"]))
            if q.get("q"):
                s = q["q"]
                rows = [o for o in rows if s in o["orderId"] or s in o["name"] or s in o["phone"]]
                if "limit" not in q: return self.send(200, {"orders": rows})
                lim = max(1, min(100, int(q.get("limit") or 10) if q.get("limit", "").isdigit() else 10))
                return self.send(200, {"orders": rows[:lim], "nextCursor": None, "total": len(rows)})
            if "limit" not in q: return self.send(200, {"orders": rows})
            lim = max(1, min(100, int(q["limit"]) if q["limit"].isdigit() else 10))
            start = 0
            cur = unb64url(q["cursor"]) if q.get("cursor") else None
            if cur and isinstance(cur, list) and cur and isinstance(cur[0], list):
                cms, cid = cur[0]
                start = next((i for i, o in enumerate(rows) if (o["createdAtMs"], o["orderId"]) < (cms, cid)), len(rows))
            page = rows[start:start + lim]
            nxt = b64url([[page[-1]["createdAtMs"], page[-1]["orderId"]]]) if len(page) == lim and start + lim < len(rows) else None
            return self.send(200, {"orders": page, "nextCursor": nxt, "total": len(rows)})
        mo = re.fullmatch(r"/api/admin/orders/([^/]+)/(status|note)", p)
        if mo and m == "PATCH":
            if not can_write(user): return self.fail(403, "Forbidden")
            oid = unquote(mo.group(1)); o = ORDERS.get(oid)
            j = self.json_body()
            if not isinstance(j, dict): return self.fail(400, "คำขอไม่ถูกต้อง")
            if mo.group(2) == "status":
                if j.get("status") not in STATUSES: return self.fail(400, "สถานะไม่ถูกต้อง")
                tn = j.get("trackingNumber", "")
                if not isinstance(tn, str) or len(tn) > 80: return self.fail(400, "เลขพัสดุไม่ถูกต้อง")
                if j["status"] in NEEDS_TRACKING and not tn: return self.fail(400, "กรุณากรอกเลขพัสดุ")
            else:
                if not isinstance(j.get("adminNote"), str) or len(j["adminNote"]) > 250: return self.fail(400, "หมายเหตุยาวเกิน 250 ตัวอักษร")
            if not o: return self.fail(404, f"Order not found: {oid}")
            if not partner_ok(o["partnerCode"]): return self.fail(403, "Forbidden")
            if mo.group(2) == "status": o["status"], o["trackingNumber"] = j["status"], j.get("trackingNumber", "")
            else: o["adminNote"] = j["adminNote"]
            return self.send(200, {"success": True})
        # dashboard
        if p == "/api/admin/dashboard-stats" and m == "GET":
            if q.get("partner") and not partner_ok(q["partner"]): return self.fail(403, "Forbidden")
            codes = [q["partner"]] if q.get("partner") else scope
            if codes is not None and not codes: return self.send(200, {"orderCount": 0, "totalSales": 0})
            rows = [o for o in ORDERS.values() if codes is None or o["partnerCode"] in codes]
            if q.get("from"): rows = [o for o in rows if ict_day(o["createdAtMs"]) >= q["from"]]
            if q.get("to"): rows = [o for o in rows if ict_day(o["createdAtMs"]) <= q["to"]]
            time.sleep(LATENCY)  # an aggregation costs a little more
            return self.send(200, {"orderCount": len(rows), "totalSales": sum(o["total"] for o in rows if o["status"] != "ยกเลิก")})
        # products
        if p == "/api/admin/products" and m == "GET":
            if q.get("partner") and not partner_ok(q["partner"]): return self.fail(403, "Forbidden")
            codes = [q["partner"]] if q.get("partner") else scope
            rows = [x for x in PRODUCTS.values() if codes is None or x["partnerCode"] in codes]
            rows.sort(key=lambda x: (x["partnerCode"], x["sortOrder"], x["id"]))
            if q.get("q"):
                s = q["q"].lower()
                rows = [x for x in rows if s in x["id"].lower() or s in x["name"].lower() or s in x["partnerCode"].lower() or s in (x["unit"] or "").lower()]
                return self.send(200, {"products": rows[:10], "nextCursor": None, "total": len(rows)})
            start = 0
            if q.get("cursor"):
                cur = unb64url(q["cursor"]); start = next((i + 1 for i, x in enumerate(rows) if x["id"] == cur), 0)
            page = rows[start:start + 10]
            return self.send(200, {"products": page, "nextCursor": b64url(page[-1]["id"]) if len(page) == 10 and start + 10 < len(rows) else None, "total": len(rows)})
        if p == "/api/admin/products" and m == "POST":
            if not can_write(user): return self.fail(403, "Forbidden")
            j = self.json_body()
            if not isinstance(j, dict): return self.fail(400, "คำขอไม่ถูกต้อง")
            if not isinstance(j.get("id"), str) or not 2 <= len(j["id"]) <= 60: return self.fail(400, "รหัสสินค้าต้องมี 2–60 ตัวอักษร")
            if not isinstance(j.get("partnerCode"), str) or not 2 <= len(j["partnerCode"]) <= 40: return self.fail(400, "รหัสพาร์ทเนอร์ไม่ถูกต้อง")
            if not isinstance(j.get("partnerName"), str) or not j["partnerName"]: return self.fail(400, "กรุณากรอกชื่อพาร์ทเนอร์")
            if not isinstance(j.get("name"), str) or not 1 <= len(j["name"]) <= 120: return self.fail(400, "กรุณากรอกชื่อสินค้า")
            if not isinstance(j.get("price"), (int, float)) or j["price"] < 0: return self.fail(400, "ราคาไม่ถูกต้อง")
            if not partner_ok(j["partnerCode"]): return self.fail(403, "Forbidden")
            with LOCK:
                if j["id"] in PRODUCTS: return self.fail(409, f"มีรหัสสินค้านี้อยู่แล้ว: {j['id']}")
                PRODUCTS[j["id"]] = {"id": j["id"], "partnerCode": j["partnerCode"], "partnerName": j["partnerName"], "name": j["name"], "unit": j.get("unit", ""),
                                     "price": j["price"], "was": j.get("was"), "badge": j.get("badge"), "pictureUrl": j.get("pictureUrl"),
                                     "active": j.get("active", True), "outOfStock": j.get("outOfStock", False), "sortOrder": j.get("sortOrder", 0)}
            return self.send(201, {"success": True, "id": j["id"]})
        mp = re.fullmatch(r"/api/admin/products/([^/]+)", p)
        if mp and m in ("PUT", "DELETE"):
            if not can_write(user): return self.fail(403, "Forbidden")
            pid = unquote(mp.group(1)); x = PRODUCTS.get(pid)
            if m == "PUT":
                j = self.json_body()
                if not isinstance(j, dict): return self.fail(400, "คำขอไม่ถูกต้อง")
                if "price" in j and (not isinstance(j["price"], (int, float)) or j["price"] < 0): return self.fail(400, "ราคาไม่ถูกต้อง")
            if not x: return self.fail(404, f"Product not found: {pid}")
            if not partner_ok(x["partnerCode"]): return self.fail(403, "Forbidden")
            if m == "PUT":
                for k, v in j.items():
                    if k not in ("id", "partnerCode"): x[k] = v
            else:
                with LOCK: PRODUCTS.pop(pid, None)
            return self.send(200, {"success": True})
        # partners
        if p == "/api/admin/partners" and m == "GET":
            return self.send(200, {"partners": sorted(PARTNERS.values(), key=lambda x: x["partnerCode"])})
        if p == "/api/admin/partners" and m == "POST":
            if user["role"] != "SUPER_ADMIN": return self.fail(403, "Forbidden")
            j = self.json_body()
            if not isinstance(j, dict): return self.fail(400, "คำขอไม่ถูกต้อง")
            code = str(j.get("partnerCode", "")).upper()
            if not re.fullmatch(r"[A-Z0-9_-]{1,20}", code): return self.fail(400, "รหัสพาร์ทเนอร์ไม่ถูกต้อง")
            if not isinstance(j.get("name"), str) or not 1 <= len(j["name"]) <= 200: return self.fail(400, "กรุณากรอกชื่อพาร์ทเนอร์")
            with LOCK:
                if code in PARTNERS: return self.fail(409, f"มีรหัสพาร์ทเนอร์นี้อยู่แล้ว: {code}")
                PARTNERS[code] = {"id": code, "partnerCode": code, "name": j["name"], "qrImageUrl": j.get("qrImageUrl"), "isActive": True}
            return self.send(201, {"success": True, "id": code})
        mpa = re.fullmatch(r"/api/admin/partners/([^/]+)(/active)?", p)
        if mpa and m in ("PUT", "PATCH"):
            if user["role"] != "SUPER_ADMIN": return self.fail(403, "Forbidden")
            pid = unquote(mpa.group(1)); x = PARTNERS.get(pid)
            j = self.json_body()
            if not isinstance(j, dict): return self.fail(400, "คำขอไม่ถูกต้อง")
            if mpa.group(2):
                if not isinstance(j.get("isActive"), bool): return self.fail(400, "isActive must be boolean")
                if not x: return self.fail(404, f"Partner not found: {pid}")
                x["isActive"] = j["isActive"]
            else:
                if not x: return self.fail(404, f"Partner not found: {pid}")
                for k in ("name", "qrImageUrl"):
                    if k in j: x[k] = j[k]
            return self.send(200, {"success": True})
        # users
        if p.startswith("/api/admin/users"):
            if user["role"] != "SUPER_ADMIN": return self.fail(403, "Forbidden")
            if p == "/api/admin/users" and m == "GET":
                return self.send(200, {"users": [{k: v for k, v in u.items() if k != "password"} for u in USERS.values()]})
            if p == "/api/admin/users" and m == "POST":
                j = self.json_body()
                if not isinstance(j, dict): return self.fail(400, "คำขอไม่ถูกต้อง")
                un = j.get("username")
                if not isinstance(un, str) or not re.fullmatch(r"[a-z0-9_.@-]{3,50}", un): return self.fail(400, "ชื่อผู้ใช้ไม่ถูกต้อง")
                if not isinstance(j.get("name"), str) or not 1 <= len(j["name"]) <= 200: return self.fail(400, "กรุณากรอกชื่อ")
                if not isinstance(j.get("password"), str) or len(j["password"]) < 8: return self.fail(400, "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร")
                if j.get("role") not in ("SUPER_ADMIN", "PARTNER_ADMIN", "PARTNER_VIEWER"): return self.fail(400, "role ไม่ถูกต้อง")
                pr = j.get("partnerRoles") or {}
                if j["role"] == "SUPER_ADMIN" and pr: return self.fail(400, "SUPER_ADMIN ต้องไม่ผูกพาร์ทเนอร์")
                if j["role"] != "SUPER_ADMIN" and not 1 <= len(pr) <= 30: return self.fail(400, "ต้องผูกพาร์ทเนอร์ 1–30 ร้าน")
                for code in pr:
                    if code not in PARTNERS: return self.fail(400, f"ไม่พบพาร์ทเนอร์: {code}")
                time.sleep(BCRYPT)
                with LOCK:
                    if un in USERS: return self.fail(409, f"มีชื่อผู้ใช้นี้อยู่แล้ว: {un}")
                    uid = f"u-{len(USERS) + 1}-{un}"
                    USERS[un] = {"id": uid, "username": un, "password": j["password"], "name": j["name"], "role": j["role"], "partnerRoles": pr, "isActive": True}
                return self.send(201, {"success": True, "id": uid})
            mu = re.fullmatch(r"/api/admin/users/([^/]+)(/active)?", p)
            if mu and m in ("PUT", "PATCH"):
                uid = unquote(mu.group(1)); x = next((u for u in USERS.values() if u["id"] == uid), None)
                j = self.json_body()
                if not isinstance(j, dict): return self.fail(400, "คำขอไม่ถูกต้อง")
                if mu.group(2):
                    if not isinstance(j.get("isActive"), bool): return self.fail(400, "isActive must be boolean")
                    if not x: return self.fail(404, "User not found")
                    x["isActive"] = j["isActive"]
                else:
                    if "password" in j and (not isinstance(j["password"], str) or len(j["password"]) < 8): return self.fail(400, "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร")
                    if not x: return self.fail(404, "User not found")
                    if "password" in j: time.sleep(BCRYPT)
                    for k in ("name", "password", "partnerRoles"):
                        if k in j: x[k] = j[k]
                return self.send(200, {"success": True})
            return self.fail(404, "Not found")
        # discount codes
        if p == "/api/admin/discount-codes" and m == "GET":
            t = q.get("type")
            if t not in ("referral", "promotion"): return self.fail(400, "type ไม่ถูกต้อง")
            if t == "referral" and user["role"] != "SUPER_ADMIN": return self.fail(403, "Forbidden")
            rows = [d for (ty, c, pc), d in DISCOUNTS.items() if ty == t and (scope is None or ty == "referral" or pc in scope)]
            return self.send(200, {"codes": rows})
        if p == "/api/admin/discount-codes" and m == "POST":
            if not can_write(user): return self.fail(403, "Forbidden")
            j = self.json_body()
            if not isinstance(j, dict): return self.fail(400, "คำขอไม่ถูกต้อง")
            ct = j.get("codeType")
            if ct not in ("referral", "promotion"): return self.fail(400, "ประเภทรหัสไม่ถูกต้อง")
            code = str(j.get("code", "")).upper()
            if ct == "referral" and not re.fullmatch(r"\d{1,10}", code): return self.fail(400, "รหัสผู้แนะนำต้องเป็นตัวเลขไม่เกิน 10 หลัก")
            if ct == "promotion" and not re.fullmatch(r"[A-Z0-9_-]{1,20}", code): return self.fail(400, "รหัสโปรโมชั่นไม่ถูกต้อง")
            if j.get("discountType") not in ("AMOUNT", "PER_PACK", "PERCENT"): return self.fail(400, "ส่วนลดไม่ถูกต้อง")
            dv = j.get("discountValue")
            if not isinstance(dv, (int, float)) or dv < 0 or (j["discountType"] == "PERCENT" and dv > 100): return self.fail(400, "ส่วนลดไม่ถูกต้อง")
            vf, vt = j.get("validFrom"), j.get("validTo") or ""
            if not isinstance(vf, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", vf): return self.fail(400, "วันที่เริ่มไม่ถูกต้อง")
            if vt and vt < vf: return self.fail(400, "ช่วงวันไม่ถูกต้อง")
            if ct == "referral":
                if user["role"] != "SUPER_ADMIN": return self.fail(403, "Forbidden")
                with LOCK:
                    if ("referral", code, "") in DISCOUNTS: return self.fail(409, f"มีรหัสนี้อยู่แล้ว: {code}", {"fieldErrors": {"code": f"มีรหัสนี้อยู่แล้ว: {code}"}})
                    DISCOUNTS[("referral", code, "")] = {"codeType": "referral", "code": code, "partnerCode": None, "discountType": j["discountType"], "discountValue": dv, "validFrom": vf, "validTo": vt, "isActive": j.get("isActive", True)}
                    AUDIT.append(("CREATE", code, ""))
                return self.send(201, {"success": True, "code": code})
            codes = j.get("partnerCodes") or []
            if not isinstance(codes, list) or not codes: return self.fail(400, "กรุณาเลือกพาร์ทเนอร์")
            if "*" in codes: return self.fail(400 if user["role"] == "SUPER_ADMIN" else 403, "ห้ามสร้างโปรโมชั่นแบบทุกพาร์ทเนอร์ ให้เลือกพาร์ทเนอร์แทน" if user["role"] == "SUPER_ADMIN" else "Forbidden")
            for c in codes:
                if c not in PARTNERS or not PARTNERS[c]["isActive"] or not partner_ok(c): return self.fail(403, "Forbidden")
            with LOCK:
                dup = [c for c in codes if ("promotion", code, c) in DISCOUNTS]
                if dup: return self.fail(409, f"มีรหัสนี้อยู่แล้ว: {code}", {"fieldErrors": {"code": f"มีรหัสนี้อยู่แล้ว: {code}"}})
                for c in codes:
                    DISCOUNTS[("promotion", code, c)] = {"codeType": "promotion", "code": code, "partnerCode": c, "discountType": j["discountType"], "discountValue": dv, "validFrom": vf, "validTo": vt, "isActive": j.get("isActive", True), "conditions": j.get("conditions", "")}
                    AUDIT.append(("CREATE", code, c))
            return self.send(201, {"success": True, "code": code, "created": len(codes)})
        md = re.fullmatch(r"/api/admin/discount-codes/([^/]+)(/active)?", p)
        if md and m in ("PUT", "PATCH"):
            if not can_write(user): return self.fail(403, "Forbidden")
            t = q.get("type")
            if t not in ("referral", "promotion"): return self.fail(400, "type ไม่ถูกต้อง")
            if t == "promotion" and not q.get("partner"): return self.fail(400, "partner ไม่ถูกต้อง")
            code = unquote(md.group(1)).upper(); pc = q.get("partner", "") if t == "promotion" else ""
            if t == "referral" and user["role"] != "SUPER_ADMIN": return self.fail(403, "Forbidden")
            if t == "promotion" and not partner_ok(pc): return self.fail(403, "Forbidden")
            j = self.json_body()
            if not isinstance(j, dict): return self.fail(400, "คำขอไม่ถูกต้อง")
            d = DISCOUNTS.get((t, code, pc))
            if md.group(2):
                if not isinstance(j.get("isActive"), bool): return self.fail(400, "isActive must be boolean")
                if not d: return self.fail(404, f"ไม่พบรหัสส่วนลด: {code}")
                d["isActive"] = j["isActive"]; AUDIT.append(("ACTIVATE" if j["isActive"] else "DEACTIVATE", code, pc))
                return self.send(200, {"success": True})
            if not d: return self.fail(404, f"ไม่พบรหัสส่วนลด: {code}")
            dt, dv = j.get("discountType", d["discountType"]), j.get("discountValue", d["discountValue"])
            if dt not in ("AMOUNT", "PER_PACK", "PERCENT") or not isinstance(dv, (int, float)) or dv < 0 or (dt == "PERCENT" and dv > 100):
                return self.fail(400, "ส่วนลดไม่ถูกต้อง", {"fieldErrors": {"discountValue": "ส่วนลดไม่ถูกต้อง"}})
            vf, vt = j.get("validFrom", d["validFrom"]), j.get("validTo", d["validTo"]) or ""
            if vt and vt < vf: return self.fail(400, "ช่วงวันไม่ถูกต้อง")
            d.update({"discountType": dt, "discountValue": dv, "validFrom": vf, "validTo": vt})
            for k in ("isActive", "conditions"):
                if k in j: d[k] = j[k]
            AUDIT.append(("UPDATE", code, pc))
            return self.send(200, {"success": True})
        # slip
        ms = re.fullmatch(r"/api/admin/slip/([^/]+)", p)
        if ms and m == "GET":
            fid = unquote(ms.group(1))
            if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", fid): return self.send(400, raw=b"Invalid file id", ctype="text/plain")
            if f"slips/{fid}" not in GCS: return self.send(404, raw=b"Not found", ctype="text/plain")
            time.sleep(LATENCY)  # a GCS fetch
            return self.send(200, raw=PNG * 64, ctype="image/png", headers={"Cache-Control": "private, max-age=3600"})
        # uploads
        if p in ("/api/admin/upload/product-image", "/api/admin/upload/qr-image") and m == "POST":
            if p.endswith("qr-image") and user["role"] != "SUPER_ADMIN": return self.fail(403, "Forbidden")
            parts = parse_multipart(self.headers.get("content-type"), self.body())
            if parts is None: return self.fail(400, "Invalid form data")
            img = parts.get("image")
            if not img or not img[0]: return self.fail(400, "No file uploaded")
            if img[1] not in ("image/jpeg", "image/png"): return self.fail(400, "รองรับเฉพาะไฟล์ภาพ JPG และ PNG")
            if len(img[2]) > 4 * 1024 * 1024: return self.fail(413, "ไฟล์ใหญ่เกิน 4 MB")
            folder = "qr-code-payment" if p.endswith("qr-image") else "products"
            if folder == "products":  # the app (2026-10-13) binds the image to a partner
                pc = (parts.get("partnerCode") or (None, None, b""))[2].decode().strip()
                if not pc: return self.fail(400, "Missing partnerCode")
                if not partner_ok(pc): return self.fail(403, "Forbidden")
            fid = f"{'qr' if folder.startswith('qr') else 'img'}-{int(time.time())}-{os.urandom(4).hex()}.{'jpg' if img[1] == 'image/jpeg' else 'png'}"
            with LOCK: GCS.add(f"{folder}/{fid}")
            return self.send(200, {"success": True, "url": f"https://storage.googleapis.com/demo-project/{folder}/{fid}", "fileId": fid})
        if p == "/api/admin/upload/product-image" and m == "DELETE":
            fid = q.get("fileId", "")
            if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", fid): return self.fail(400, "Invalid file id")
            with LOCK:
                if f"products/{fid}" not in GCS: return self.fail(404, "Not found")
                GCS.discard(f"products/{fid}")
            return self.send(200, {"success": True})
        return self.fail(404, "Not found")

class Server(ThreadingHTTPServer):
    request_queue_size = 1024
    daemon_threads = True

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18090
    print(f"mock pmc-line on http://127.0.0.1:{port} · {len(ORDERS)} orders · {len(PRODUCTS)} products · latency {int(LATENCY * 1000)} ms · bcrypt {int(BCRYPT * 1000)} ms", flush=True)
    Server(("127.0.0.1", port), H).serve_forever()
