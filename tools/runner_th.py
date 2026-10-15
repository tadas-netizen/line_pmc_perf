"""Thai text for tools/runner.py's settings table (the page's TH language). Keyed like CASES:
FIELDS = per setting key (shared by every scenario that uses it), CASES = per scenario, with
`fields` overriding FIELDS where a scenario words a setting differently. Missing entries fall
back to the English text, so a new setting shows in English until it is added here."""

FIELDS = {
    "PERF_RAMP": {"label": "Ramp up", "hint": "เวลาไต่จาก 0 ถึงโหลดเป้าหมาย — นับรวมในการวัด",
                  "info": "เวลาที่โหลดไต่จากศูนย์ถึงเป้าหมาย request ช่วง ramp นับรวมใน PASS/FAIL (ติด tag stage=ramp-up สำหรับกราฟ) รูปแบบ: 30s, 2m, 1m30s"},
    "PERF_HOLD": {"label": "แช่", "hint": "ช่วงคงที่ที่เป้าหมาย",
                  "info": "เวลาที่โหลดคงอยู่ที่เป้าหมาย PASS/FAIL (p95 ≤ เกณฑ์, error < เกณฑ์ โดยนับ response ที่ช้ากว่าเกณฑ์ช้าเป็น error) วัดทั้งรอบ: ramp up + แช่ + ramp down (ขั้นบันได: ramp + แช่ ของขั้นนั้น) แช่นานขึ้น ช่วง ramp มีน้ำหนักน้อยลงและตัวเลขนิ่งขึ้น แต่สร้างข้อมูลมากขึ้นในแบบที่เขียนข้อมูล"},
    "PERF_RAMP_DOWN": {"label": "Ramp down", "hint": "เวลาลดจากเป้าหมายกลับเป็น 0 — นับรวมในการวัด",
                       "info": "เวลาที่โหลดลดลงหลังช่วงแช่ request ช่วงนี้นับรวมใน PASS/FAIL ด้วย (stage=ramp-down)"},
    "PERF_ADMIN_ROLE": {"label": "Role ของ admin", "dflt": "super",
                        "hint": "cookie ที่ใช้ยิงเส้น admin: super (เห็นทุกร้าน) หรือ partner (เฉพาะร้านตัวเอง)",
                        "info": "session ที่เส้น admin และ journey ใช้: super = SUPER_ADMIN (เห็นทุกพาร์ทเนอร์ ไม่ส่ง ?partner=) · partner = PARTNER_ADMIN (เห็นเฉพาะร้านที่ผูกไว้ ใช้ in query; PERF_PARTNER คือร้านที่ใช้เมื่อต้องระบุร้านเดียว) · เส้น super-only (users / partners / QR) ใช้บัญชี SUPER_ADMIN เสมอ",
                        "options": [["", "super (SUPER_ADMIN)"], ["partner", "partner (PARTNER_ADMIN เฉพาะร้าน)"]]},
    "PERF_RPS": {"label": "Rate (TPS)", "dflt": "ค่าตั้งต้นของแต่ละเส้น (ตามเอกสาร List Load Test: 50 สำหรับ admin orders / products / dashboard, 10 สั่งซื้อ, 20 read อื่น, 5 write, 2 เส้น bcrypt, 1 read หนัก)",
                 "hint": "จำนวน TPS ที่ยิง endpoint (โหมด target)",
                 "info": "อัตรายิงคงที่ เป็น TPS k6 เริ่ม request ตามอัตรานี้ไม่ว่าเซิร์ฟเวอร์จะตอบเร็วแค่ไหน ว่าง = ค่าตั้งต้นของเส้นนั้น (lib/endpoints.js `rate` ตามเอกสาร) ไม่ใช้เมื่อใส่ขั้นบันได"},
    "PERF_STEPS": {"label": "ขั้นบันได", "dflt": "ไม่มี — โหมด target (rate เดียว)",
                   "hint": "เช่น 25,50,100 — เปลี่ยนเป็นโหมดหาความจุ (ladder)",
                   "info": "รายการ rate คั่นด้วย , แต่ละขั้น ramp แล้วแช่ตามเวลาแช่ และตัดสินจากช่วงของขั้นนั้นเอง (ramp + แช่) ผลคือขั้นสูงสุดที่ยังอยู่ในเกณฑ์ ('capacity') หยุดก่อนถ้าขั้นใดพังชัดเจน (p95 > 2 เท่าของเกณฑ์ หรือ error > 5 %) ว่าง = โหมด target rate เดียว"},
    "PERF_ENDPOINT": {"label": "Endpoint", "hint": "endpoint ที่จะทดสอบ — badge บอก read / auth / write",
                      "info": "endpoint ใดก็ได้จาก lib/endpoints.js · read = ยิงซ้ำได้ ไม่สร้างข้อมูล (heavy = read ไม่จำกัดจำนวนของ admin orders อ่านทุกใบในขอบเขตต่อ request) · auth = login (bcrypt) · write = สร้างหรือแก้ข้อมูลทุก request (ดูว่าทิ้งอะไรไว้ในรายการ)"},
    "PERF_MAX_VUS": {"label": "VU สูงสุด", "hint": "เพดานจำนวน virtual user พร้อมกัน",
                     "info": "k6 เพิ่ม VU ตามที่ต้องใช้เพื่อรักษา rate ช่องนี้คือเพดาน เพิ่มเฉพาะเมื่อรอบนั้นรายงาน dropped iterations"},
    "TS01_GAP": {"label": "พักระหว่างเส้น (วิ)", "dflt": "60 วิ", "hint": "พักระหว่าง endpoint",
                 "info": "จำนวนวินาทีที่รอหลัง endpoint หนึ่งจบก่อนเริ่มตัวถัดไป ให้หางของเส้นก่อนไม่ทับการวัดของเส้นถัดไป"},
    "ENDPOINTS": {"label": "Endpoints", "dflt": "ติ๊ก read ทุกเส้นไว้ให้ (ไม่รวม read หนัก)",
                  "hint": "ติ๊ก endpoint ที่จะยิง เรียงตามลำดับนี้ · แต่ละเส้นใส่ TPS ของตัวเองได้",
                  "info": "endpoint ที่จะยิงทีละเส้น (id คั่นด้วย , จาก lib/endpoints.js) หน้าเว็บแสดงเป็นรายการให้ติ๊ก มีปุ่มเลือกเร็วและช่อง TPS ต่อเส้น · read = ปลอดภัย · heavy = read ไม่จำกัดจำนวน (อ่านทุกใบในขอบเขตต่อ request) แยกทดสอบ ตั้งต้น 1 TPS · auth = login bcrypt · write = สร้างหรือแก้ข้อมูลทุก request"},
    "TS01_RATES": {"label": "Rate รายเส้น", "dflt": "ไม่มี — ทุกเส้นใช้ Rate (TPS)",
                   "hint": "คู่ id:TPS จากช่อง TPS ในรายการ",
                   "info": "rate รายเส้น (id:rps,…) จากช่อง TPS ข้างแต่ละ endpoint ช่องว่างใช้ Rate (TPS) ด้านล่าง (หรือค่าตั้งต้นของเส้น) ไม่ใช้เมื่อใส่ขั้นบันได"},
    "PERF_SMOKE_SECTIONS": {"label": "ส่วนที่ยิง", "dflt": "all (หน้าเว็บใส่ all ให้ · สคริปต์เปล่า ๆ ใช้ public,auth,neg,ts01)",
                            "hint": "public,auth,neg,ts01,order,writes — หรือ all",
                            "info": "ส่วนที่จะตรวจ: public = GET /api/products, POST /api/discount/validate, GET /api/product-image · auth = login ทุก role ที่ตั้งไว้ + logout · neg = ไม่มี cookie → 401, viewer เขียน → 403, ร้านนอกขอบเขต → 403, บัญชีปิด → 401 · ts01 = ทุก read endpoint ของ TS-01 ครั้งละ 1 · order = สั่งซื้อจริง 1 ใบพร้อมสลิป · writes = ทุก write endpoint ครั้งละ 1 คั่นด้วย , หรือ `all`"},
    "PERF_DEBUG": {"label": "พิมพ์ที่ fail", "dflt": "เปิด", "hint": "พิมพ์ status + body ของทุก check ที่ fail ลง k6 log",
                   "info": "เปิด: ทุก check ที่ fail พิมพ์ status และ body ของ response ลง log (เปิด 'k6 log' ใต้ผล) ปิดเฉพาะรอบที่ log เยอะมาก",
                   "options": [["1", "เปิด"], ["", "ปิด"]]},
    "TSALL_TS01": {"label": "TS-01 Endpoint (ทั้งหมด)", "dflt": "รวม", "hint": "34 endpoint ทีละเส้น (ไม่รวม read หนัก) ≈ 3 ชม. 40 นาที",
                   "info": "TS-01 Endpoint (Group Run) ทุก endpoint ยกเว้น read หนัก: read → auth → write แต่ละเส้นใช้ rate ตั้งต้น shape มาตรฐาน พัก 60 วิระหว่างเส้น write สร้างข้อมูล"},
    "TSALL_TS02": {"label": "TS-02 Storefront", "dflt": "รวม", "hint": "ลูกค้าสั่งซื้อ 10 ใบ/วิ ≈ 6 นาที — สร้างออเดอร์จริง",
                   "info": "ลูกค้า LINE OA สั่งซื้อที่ 10 ใบ/วิ (≈ 23 TPS): catalog → อาจเช็คโค้ด → สั่งซื้อพร้อมสลิป ≈ 6 นาที สร้างออเดอร์จริง ≈ 3,300 ใบ"},
    "TSALL_TS03": {"label": "TS-03 Admin orders", "dflt": "รวม", "hint": "หน้าจัดการออเดอร์ 50 TPS ≈ 6 นาที",
                   "info": "หน้าจัดการออเดอร์ที่ 50 TPS: list → filter → หน้าถัดไป → สลิป → note / status ≈ 6 นาที แก้ note / status ของออเดอร์ที่มีอยู่"},
    "TSALL_TS04": {"label": "TS-04 Dashboard", "dflt": "รวม", "hint": "dashboard 50 TPS ≈ 6 นาที",
                   "info": "dashboard ของ admin ที่ 50 TPS: stats + partners พร้อมกัน บางครั้งเลือกช่วงวัน ≈ 6 นาที อ่านอย่างเดียว"},
    "TSALL_TS01_TPS": {"label": "TS-01 TPS (read)", "dflt": "ค่าตั้งต้นของแต่ละเส้น",
                       "hint": "rate ของทุก endpoint read ในส่วน TS-01 — จำนวนเต็ม",
                       "info": "TPS ของ endpoint read แต่ละเส้นในส่วน TS-01 (ยังยิงทีละเส้นเหมือนเดิม) ว่าง = ค่าตั้งต้นของเส้น (50 สำหรับ admin orders / dashboard / products, 20 ที่เหลือ) auth และ write มีช่องของตัวเอง ใส่จำนวนเต็มเท่านั้น"},
    "TSALL_TS01_AUTH_TPS": {"label": "TS-01 TPS (auth)", "dflt": "2 (ค่าตั้งต้นของเส้น)",
                            "hint": "rate ของเส้น login — bcrypt ให้ต่ำไว้",
                            "info": "TPS ของ POST /api/admin/login ในส่วน TS-01 ทุก call คือ bcrypt hash (cost 12 ~100 ms CPU) วัดว่า login แพงแค่ไหน ไม่ใช่หาเพดาน ว่าง = 2 ใส่จำนวนเต็มเท่านั้น"},
    "TSALL_TS01_WRITE_TPS": {"label": "TS-01 TPS (write)", "dflt": "ค่าตั้งต้นของแต่ละเส้น (10 สั่งซื้อ / แก้ออเดอร์, 5 write อื่น, 2 create ที่ bcrypt)",
                             "hint": "rate ของทุก endpoint write ในส่วน TS-01 — สร้างข้อมูล",
                             "info": "TPS ของ endpoint write แต่ละเส้นในส่วน TS-01 แต่ละ request สร้างหรือแก้ document (และไฟล์ GCS สำหรับออเดอร์ / อัปโหลด) เพิ่ม TPS = ทิ้งข้อมูลไว้มากขึ้นตามสัดส่วน ว่าง = ค่าตั้งต้น ใส่จำนวนเต็มเท่านั้น"},
    "TSALL_RAMP": {"label": "Ramp up (ทุก TS)", "hint": "ramp up เท่ากันทุก TS — นับรวมในการวัด",
                   "info": "ramp up ที่ทุก TS ใช้ (ส่งต่อเป็น PERF_RAMP · TS-01 ใช้เป็น ramp ของแต่ละขั้นด้วย) รูปแบบ: 30s, 2m, 1m30s"},
    "TSALL_HOLD": {"label": "แช่ (ทุก TS)", "hint": "แช่เท่ากันทุก TS — เช่น 1m สำหรับซ้อม",
                   "info": "เวลาแช่ที่ทุก TS ใช้ (ส่งต่อเป็น PERF_HOLD) แช่สั้นลงทำให้ทั้งชุดสั้นลงมาก (TS-01 อย่างเดียวมี 34 endpoint) แต่ตัวเลขแกว่งกว่า รอบจริงใช้ 5m"},
    "TSALL_RAMP_DOWN": {"label": "Ramp down (ทุก TS)", "hint": "ramp down เท่ากันทุก TS — นับรวมในการวัด",
                        "info": "ramp down ที่ทุก TS ใช้ (ส่งต่อเป็น PERF_RAMP_DOWN)"},
    "TSALL_GAP": {"label": "พักระหว่าง TS (วิ)", "dflt": "60 วิ", "hint": "พักระหว่าง TS หนึ่งกับตัวถัดไป",
                  "info": "จำนวนวินาทีระหว่างจบ TS หนึ่งกับเริ่มตัวถัดไป ให้หางของเทสต์ก่อนไม่ทับการวัดของตัวถัดไป (TS-01 ยังพัก 60 วิระหว่างเส้นของตัวเอง)"},
    "CHECK_GAP": {"label": "พัก (วิ)", "dflt": "1 วิ", "hint": "พักหลังแต่ละ endpoint", "info": "จำนวนวินาทีระหว่าง endpoint ให้หางที่ช้าของเส้นก่อนไม่ไปถึงเส้นถัดไป"},
    "PERF_ORDERS_PER_SEC": {"label": "ออเดอร์/วิ", "dflt": "10 (≈ 23 TPS)", "hint": "จำนวนออเดอร์ที่สั่งต่อวินาที — ปุ่มโหลดหลัก",
                            "info": "ออเดอร์ที่สั่งต่อวินาทีรวมทุกร้าน k6 เริ่มลูกค้าใหม่ตามอัตรานี้ไม่ว่าเซิร์ฟเวอร์จะเร็วแค่ไหน TPS ≈ ออเดอร์/วิ × 2.3 ที่ค่าตั้งต้นอื่น เอกสารบรรทัด #1 คือ 10 TPS ที่ POST /api/orders"},
    "PERF_P_VALIDATE": {"label": "P(เช็คโค้ด)", "dflt": "0.3 (30 % ของออเดอร์)", "hint": "สัดส่วนลูกค้าที่เช็ครหัสผู้แนะนำก่อน",
                        "info": "ความน่าจะเป็น (0–1) ที่ลูกค้าเช็ครหัสผู้แนะนำ (POST /api/discount/validate เส้นสาธารณะ) ก่อนสั่ง ถ้ารหัสผ่าน ออเดอร์จะแนบรหัสนั้น"},
    "PERF_PARTNERS": {"label": "พาร์ทเนอร์", "dflt": "ทุกร้านที่มีสินค้าสั่งได้", "hint": "รายการรหัสร้านคั่นด้วย , ที่จะกระจายออเดอร์",
                      "info": "จำกัดหน้าร้านไว้ที่รหัสร้านเหล่านี้ (คั่นด้วย ,) ว่าง = ทุกร้านที่มีสินค้า active และไม่หมดใน GET /api/products ร้านเดียว = counter เดียว = ทดสอบ contention"},
    "PERF_TARGET_RPS": {"label": "Rate (TPS)", "hint": "อัตรา request คงที่", "info": "TPS เป้าหมาย"},
    "PERF_VUS": {"label": "VUs (legacy)", "dflt": "ว่าง = rate คงที่", "hint": "ใส่เพื่อใช้ n VU เดินต่อกัน",
                 "info": "จำนวน VU ที่เดินต่อกันไม่หยุดแทน arrival rate คงที่ rate จะเท่าที่เซิร์ฟเวอร์ไหว ว่าง = rate คงที่"},
    "PERF_P_SLIP": {"label": "P(สลิป)", "hint": "สัดส่วนรอบที่เปิดสลิป", "info": "ความน่าจะเป็น (0–1) ของ GET /api/admin/slip/{fileId} (binary จาก GCS) ในหนึ่งรอบ"},
    "PERF_P_NOTE": {"label": "P(note)", "hint": "สัดส่วนรอบที่เขียน note", "info": "ความน่าจะเป็น (0–1) ของ PATCH …/note ในหนึ่งรอบ (แก้ adminNote ของออเดอร์)"},
    "PERF_P_STATUS": {"label": "P(status)", "hint": "สัดส่วนรอบที่เปลี่ยนสถานะ", "info": "ความน่าจะเป็น (0–1) ของ PATCH …/status ในหนึ่งรอบ (สลับ รอตรวจสอบสลิป ↔ ยืนยันแล้ว)"},
    "PERF_P_RANGE": {"label": "P(ช่วงวัน)", "hint": "สัดส่วนการโหลดที่เลือกช่วงวัน", "info": "ความน่าจะเป็น (0–1) ที่ admin โหลด stats ของช่วงวันด้วย (from / to หมุนไปเรื่อย ๆ ให้ cache 30 วิแทบไม่โดน)"},
    "PERF_MIX": {"label": "สัดส่วน (mix)", "dflt": "order:10,products:50,orders:50,dashboard:50,catalog:10", "hint": "น้ำหนักของ 5 เส้น (ชื่อ:น้ำหนัก,…)",
                 "info": "สัดส่วนของแต่ละเส้นหลักใน mix: order = POST /api/orders, products = GET /api/products, orders = GET /api/admin/orders?limit=10, dashboard = GET /api/admin/dashboard-stats, catalog = GET /api/admin/products เป็นน้ำหนัก ไม่ใช่ TPS ที่ผลรวมตั้งต้นจะเท่ากับ TPS ต่อเส้นในเอกสารพอดี"},
    "PERF_SOAK_HOLD": {"label": "แช่", "hint": "เวลาที่ rate คงที่ (บวก ramp วัดทั้งหมด)", "info": "จุดประสงค์ของ soak คือความยาว จึงมีเวลาแช่ของตัวเองแทน 5 นาทีมาตรฐาน"},
    "PERF_STRESS_MAX": {"label": "ขั้นสูงสุด (TPS)", "dflt": "1000 TPS (20 ขั้น)", "hint": "ไต่ 50, 100, … ถึงค่านี้", "info": "บันไดไต่ 50, 100, 150 … ถึงค่านี้ ลดเพื่อให้รอบสั้นลง"},
    "PERF_STRESS_STEP": {"label": "ขั้นละ (TPS)", "hint": "เพิ่มขั้นละเท่าไร", "info": "TPS ที่เพิ่มในแต่ละขั้น"},
    "PERF_STRESS_HOLD": {"label": "แช่ต่อขั้น", "hint": "เวลาที่แต่ละขั้นคง rate (วัดรวม ramp ของขั้น)", "info": "แต่ละขั้นแช่นานเท่านี้และตัดสินจากช่วงของขั้นนั้นเอง (ramp + แช่)"},
    "PERF_SPIKE_RPS": {"label": "Peak (TPS)", "dflt": "340 TPS (2 เท่าของ mix)", "hint": "rate ที่จะกระโดดไป", "info": "TPS สูงสุด (1 request ต่อ iteration)"},
    "PERF_SPIKE_RAMP": {"label": "กระโดด", "hint": "0 → peak เร็วแค่ไหน", "info": "เวลากระโดด สั้น = spike แรง"},
    "PERF_LOGINS_PER_SEC": {"label": "Login/วิ", "hint": "login ต่อวินาที — ให้ต่ำไว้", "info": "login ที่เริ่มต่อวินาที เกิน 5 จะกิน CPU ของ function จนเต็มโดยธรรมชาติ"},
}

CASES = {
    "smoke": {"desc": "1 VU ยิงผ่านทุก request path ครั้งเดียว check เข้มงวด รันก่อนเสมอ",
              "how": "ยิงรอบเดียว ไม่มีโหลด เข้มงวด: ทุก check ต้องผ่านและห้ามมี request fail — พิสูจน์ว่าสคริปต์และ environment ใช้ได้ ไม่ใช่วัด performance รันก่อนยิงโหลดทุกครั้ง ส่วน write สร้างข้อมูล (ออเดอร์ 1 ใบ, สินค้า / โค้ด / พาร์ทเนอร์ / ผู้ใช้ perf, รูป)"},
    "tsall": {"desc": "ทั้งชุด ทีละตัว (ไม่ยิงพร้อมกัน): TS-01 ทุก endpoint → TS-02 → TS-03 → TS-04 กดเริ่ม ไปทำอย่างอื่น แล้วกลับมาดูผล",
              "how": "ตัวเริ่มชุด ไม่ใช่เทสต์ใหม่: รัน TS-01 Endpoint (Group Run) ทุก endpoint (read → auth → write ห่างกัน 60 วิ ไม่รวม read หนัก 2 เส้น) แล้ว TS-02 Storefront, TS-03 Admin orders, TS-04 Dashboard พักระหว่างกัน แต่ละ TS ใช้ค่าตั้งต้นของตัวเอง ค่าที่ใช้ร่วมคือ shape (ramp / แช่ / ramp down ตั้งต้น 30s / 5m / 30s) และ TPS ของ TS-01 ทั้งชุดที่ค่าตั้งต้น ≈ 4 ชม. (TS-01 ≈ 3 ชม. 40 นาที) TS ที่ fail ไม่หยุดชุด ผลทั้งหมดใช้ run id เดียวกัน ส่วน write สร้างข้อมูล"},
    "ts01": {"desc": "endpoint เดียว ที่ rate คงที่ (target) หรือขั้นบันได วัดรวมช่วง ramp",
             "how": "ทดสอบ endpoint เดียว โหมด target: rate เดียว PASS/FAIL ทั้งรอบ (รวม ramp) โหมด ladder: หลาย rate รายงานขั้นสูงสุดที่ยังอยู่ในเกณฑ์ cookie ของ admin ขอครั้งเดียวใน setup() (bcrypt) แล้วแชร์ทุก VU เส้น write สร้างหรือแก้ document ทุก request (fixture ต่อ VU ที่มันแก้ สร้างครั้งเดียวแบบ inactive)"},
    "ts01q": {"desc": "TS-01 Endpoint สำหรับ endpoint ที่ติ๊ก ทีละเส้น แต่ละเส้นใช้ rate ของตัวเอง พักระหว่างเส้น (scripts/ts01-queue.sh)",
              "how": "รัน TS-01 Endpoint ให้ทุก endpoint ที่ติ๊ก ทีละเส้นตามลำดับ ปุ่มเลือกเร็วติ๊กทั้งกลุ่ม (reads / heavy / auth / writes / ไม่เขียน DB / ทั้งหมด / ไม่เลือก) แต่ละเส้นใช้ rate ในช่อง TPS ของมัน ไม่งั้นใช้ Rate (TPS) ของที่เหลือ ไม่งั้นค่าตั้งต้นของเส้น \"ใช้ rate ที่ผ่านล่าสุด\" ใส่ค่าจากรอบ TS-01 ล่าสุดที่ผ่านบนปลายทางนี้ ระยะเวลา ≈ จำนวนเส้น × (ramp + แช่ × ขั้น + ramp down) + พัก verdict แยกต่อเส้น กราฟครอบทั้งรอบ"},
    "check": {"desc": "เช็กว่าแต่ละเส้นที่ติ๊กใช้งานได้ไหม ยิงสั้น ๆ ที่ rate ต่ำ (ตั้งต้น 5 TPS 1 วินาที ไม่มี ramp) ทุกเส้นใน k6 รอบเดียว — functional check ไม่ใช่การวัด performance",
              "how": "ทุก endpoint ที่ติ๊ก ยิงสั้น ๆ ที่ rate ของมัน (ตั้งต้น 5 TPS 1 วิ) ทีละเส้น พักสั้น ๆ ใน k6 รอบเดียว: role login ครั้งเดียวใน setup() (bcrypt) เส้น login เองรันท้ายสุดและ login ทุก request PASS ต่อเส้น = มี request ของเส้นนั้นอย่างน้อย 1 และไม่มีครั้งไหนตอบ status ผิด latency แสดงแต่ไม่ตัดสิน read 15 เส้น ≈ 35 วิ ปุ่ม \"ไม่เขียน DB\" ตัดทุกเส้นที่สร้างหรือแก้ข้อมูล",
              "fields": {"PERF_RPS": {"label": "Rate (TPS)", "dflt": "5 TPS", "hint": "สำหรับเส้นที่ติ๊กแต่ช่อง TPS ว่าง", "info": "request ต่อวินาทีของแต่ละ endpoint ตอนเช็ก (arrival rate คงที่ ไม่มี ramp)"},
                         "PERF_HOLD": {"label": "ยิงเส้นละ", "dflt": "1 วิ", "hint": "ยิงแต่ละเส้นนานเท่าไร", "info": "แต่ละ endpoint ยิงที่ rate นานเท่านี้ (รูปแบบเวลา k6 เช่น 1s, 5s) rate × ค่านี้ = request ต่อเส้น"}}},
    "ts02": {"desc": "ลูกค้า LINE OA: catalog → อาจเช็คโค้ด → สั่งซื้อพร้อมสลิป เป็นจำนวนออเดอร์ต่อวินาที (เอกสารบรรทัด #1: 10 TPS ที่ POST /api/orders) สร้างออเดอร์จริง",
             "how": "แต่ละ iteration = ลูกค้า 1 คน: GET /api/products?partner= → อาจ POST /api/discount/validate ตามความน่าจะเป็น → POST /api/orders (multipart: payload + สลิป) ≈ 2.3 request ต่อออเดอร์ ดังนั้น 10 ออเดอร์/วิ ≈ 23 TPS กระจายออเดอร์วนทุกร้านที่สั่งได้ เพราะเลขออเดอร์เป็น transaction บน counter เดียวต่อร้าน-เดือน (เอกสาร §3.1.1) — ร้านเดียวคือทดสอบ contention ทุกออเดอร์สร้าง document จริงและอัปสลิปขึ้น GCS"},
    "ts03": {"desc": "หน้าจัดการออเดอร์ของ admin (เอกสารบรรทัด #7: 50 TPS ที่ GET /api/admin/orders): list → filter → หน้าถัดไป → สลิป → note / status",
             "how": "แต่ละ iteration = admin 1 คนทำงานกับ list: หน้าแรก (limit 10) → กรองสถานะ → หน้าถัดไป (cursor) → ตามความน่าจะเป็น เปิดสลิป (binary จาก GCS), เขียน note, เปลี่ยนสถานะ (สลับ รอตรวจสอบสลิป ↔ ยืนยันแล้ว) ≈ 4 request ต่อ iteration ดังนั้น 50 TPS ≈ 12.5 iteration/วิ cookie ขอครั้งเดียวใน setup() แล้วแชร์ทุก VU (เอกสาร §2) note / status แก้ออเดอร์จริง",
             "fields": {"PERF_TARGET_RPS": {"dflt": "50 TPS (≈ 12.5 iteration/วิ)", "info": "TPS เป้าหมาย แปลงเป็น iteration ต่อวินาที (÷ 4) ไม่ใช้เมื่อใส่ VUs (legacy)"},
                        "PERF_MAX_VUS": {"label": "VU สูงสุด", "dflt": "60", "hint": "เพดาน admin พร้อมกัน", "info": "k6 เพิ่ม VU ตามต้องการเพื่อรักษา rate สูงสุดเท่านี้ 60 รองรับ 12.5 iteration/วิ ถ้า iteration ละไม่เกิน ~4.8 วิ"}}},
    "ts04": {"desc": "dashboard ของ admin (เอกสารบรรทัด #10: 50 TPS ที่ GET /api/admin/dashboard-stats): stats + partners พร้อมกัน บางครั้งเลือกช่วงวัน",
             "how": "แต่ละ iteration = โหลด dashboard 1 ครั้ง: GET /api/admin/dashboard-stats (Firestore aggregation, cache 30 วิต่อ key) และ GET /api/admin/partners (อ่านสด) พร้อมกัน แล้วอาจเลือกช่วงวัน (key ใหม่ → aggregation จริง) ≈ 2.3 request ต่อ iteration ดังนั้น 50 TPS ≈ 22 ครั้ง/วิ อ่านอย่างเดียว",
             "fields": {"PERF_TARGET_RPS": {"dflt": "50 TPS (≈ 22 ครั้ง/วิ)", "info": "TPS เป้าหมาย แปลงเป็นการโหลด dashboard ต่อวินาที (÷ 2.3) ไม่ใช้เมื่อใส่ VUs (legacy)"},
                        "PERF_MAX_VUS": {"label": "VU สูงสุด", "dflt": "60", "hint": "เพดาน admin พร้อมกัน", "info": "k6 เพิ่ม VU ตามต้องการเพื่อรักษา rate สูงสุดเท่านี้"}}},
    "soak": {"desc": "mix ตามลำดับความสำคัญที่ rate คงที่ แช่นาน (ตั้งต้น 170 TPS = 5 เส้นในเอกสารรวมกัน)",
             "how": "1 request ต่อ iteration สุ่มจาก 5 เส้นหลักในเอกสารตามน้ำหนัก (PERF_MIX: order 10 · products 50 · admin orders 50 · dashboard 50 · admin products 10 → 170 TPS เท่ากับตารางพอดี) แช่นานเพื่อหาการเสื่อมช้า ๆ ≈ 6 % ของ request สั่งซื้อจริง",
             "fields": {"PERF_TARGET_RPS": {"dflt": "170 TPS (ผลรวมของ mix)", "info": "TPS เป้าหมาย = iteration ต่อวินาที (request ละ 1)"}}},
    "stress": {"desc": "mix ตามลำดับความสำคัญ ไต่ทีละ +50 TPS แต่ละขั้นตัดสินจากช่วงของตัวเอง (เกณฑ์) หยุดที่ขั้นแรกที่ไม่ผ่าน",
               "how": "ไต่ mix ทีละ +50 TPS (50, 100, … ถึงขั้นสูงสุด) แต่ละขั้น ramp แล้วแช่ และตัดสินจากช่วงของตัวเอง หยุดที่ขั้นแรกที่ไม่ผ่านเกณฑ์ (p95 หรือ error ตัดสินหลังเข้าขั้น 30 วิ) ผล: ขั้นสูงสุดที่อยู่ในเกณฑ์ และจุดที่ p95 ข้ามเกณฑ์และ 500 ms อาจทำให้ environment แย่ลงและสั่งซื้อจริง ≈ 6 % ของ request — รันท้ายสุด สูงสุด ~1 ชม. 50 นาทีที่ค่าตั้งต้น",
               "fields": {"PERF_RAMP": {"label": "Ramp ต่อขั้น", "hint": "เวลาไต่ก่อนแต่ละขั้น — วัดรวมกับขั้นนั้น", "info": "เวลาที่แต่ละขั้นไต่ถึง rate ของขั้น นับรวมในช่วงของขั้นนั้น"}}},
    "spike": {"desc": "0 → peak ในไม่กี่วินาที แล้วแช่ · gate ทั้งรอบ · 30 วิแรกที่ peak แสดงแยกเป็น cold start",
              "how": "กระโดดจาก 0 ถึง peak ในไม่กี่วินาที (function ของ Vercel ต้อง scale out จากเย็น) แล้วแช่ gate ทั้งรอบ 30 วิแรกที่ peak แสดงแยกเป็น cold start ด้วย ใช้ mix ตามลำดับความสำคัญ สั่งซื้อจริง ≈ 6 %"},
    "auth": {"desc": "POST /api/admin/login อย่างเดียว — bcrypt cost 12 จึงเป็นการวัด CPU ไม่ใช่เป้า throughput",
             "how": "login ที่ rate คงที่ต่ำ ๆ (ตั้งต้น 2/วิ) สลับบัญชีที่ตั้งไว้ แต่ละ call hash รหัสผ่าน (bcrypt cost 12 ~100 ms CPU บน function): จุดประสงค์คือดูว่า login แพงแค่ไหน ไม่ใช่หาเพดาน — เอกสาร §3.2 ห้ามยิงเป็น throughput"},
}


def note(target, base, word):
    """Thai version of target_meta()'s banner for stg / prod."""
    who = "ลูกค้าและ admin จริงใช้อยู่ · " if target == "prod" else "ใช้ร่วมกับทีม · "
    return (f"{word} ({base or 'ยังไม่ได้ตั้ง host'}) · {who}host ใน .env.{target} เป็น PERF_{target.upper()}_BASE บัญชี perf เฉพาะเป็น PERF_ADMIN_* / PERF_PARTNER_* / PERF_VIEWER_* · "
            f"พิมพ์ {word} เพื่อเลือก และพิมพ์อีกครั้งทุกรอบที่ยิง")


MOCK_NOTE = "scripts/mock_line.py (ทุกเส้นตาม docs/api-spec-loadtest.md ออเดอร์ปลอม 2,000 ใบ) — พิสูจน์สคริปต์ ไม่ใช่ performance"
LOCAL_NOTE = "pmc-line dev server ในเครื่องนี้ (pnpm dev + Firestore / GCS emulator) · บัญชี = ชุด seed ของ emulator (pnpm seed:users) เว้นแต่ .env.local ระบุ · พิสูจน์สคริปต์และข้อมูลครบวงจรในเครื่องเดียว ไม่ใช่ performance"


def field(case, key):
    """Thai text for one setting of one scenario (empty dict = English only)."""
    out = dict(FIELDS.get(key, {}))
    out.update(CASES.get(case, {}).get("fields", {}).get(key, {}))
    return out
