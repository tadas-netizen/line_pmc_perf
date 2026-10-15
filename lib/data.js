import http from 'k6/http';
import { cfg } from './config.js';

// Static test data. pmc-line needs no seeded data FILES: the catalog (partners, products, prices)
// is read live from GET /api/products in setup() (lib/catalog.js), and the admin order pool from
// GET /api/admin/orders. What is read from disk, in the init context (open()):

// The slip image every POST /api/orders uploads (JPG/PNG/WebP ≤ 5 MB, docs §3.1.1; the perf seed's
// own slip is the same kind of file). fixtures/slip.png is a generated 59 KB PNG; PERF_SLIP_FILE
// points elsewhere (relative to lib/).
let slipBytes = null;
let slipName = 'slip.png';
try {
  slipBytes = open(cfg.slipFile, 'b');
  slipName = String(cfg.slipFile).split('/').pop();
} catch (e) {
  throw new Error(`cannot read the slip file ${cfg.slipFile} (PERF_SLIP_FILE, relative to lib/): ${e}`);
}
const mime = /\.jpe?g$/i.test(slipName) ? 'image/jpeg' : /\.webp$/i.test(slipName) ? 'image/webp' : 'image/png';
// A fresh FileData per call (k6 reuses the bytes; the object is cheap).
export const slipFile = () => http.file(slipBytes, slipName, mime);
export const slipInfo = () => ({ name: slipName, bytes: slipBytes ? slipBytes.byteLength : 0, mime });

// The same bytes serve the admin image uploads (JPG/PNG only there — PNG fixture).
export const imageFile = (name = 'perf-image.png') => http.file(slipBytes, name, 'image/png');

// Thai statuses (docs §4.3) — exact strings, used in bodies and (URL-encoded) in `?status=`.
export const STATUS = {
  pending: 'รอตรวจสอบสลิป',
  confirmed: 'ยืนยันแล้ว',
  shipping: 'กำลังจัดส่ง',
  delivered: 'จัดส่งแล้ว',
  cancelled: 'ยกเลิก',
};

// Thai-time date helpers (Asia/Bangkok, UTC+7, no DST) for `from` / `to` / validFrom.
const ICT = 7 * 3600 * 1000;
export const ictDateStr = (ms = Date.now()) => new Date(ms + ICT).toISOString().slice(0, 10);
export const daysAgo = (n) => ictDateStr(Date.now() - n * 86400000);

// A random Thai mobile number the order schema accepts (^0\d{8,9}$): 08x-xxx-xxxx.
export const randomPhone = () => '08' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');

// A short unique suffix for things a run creates (product / partner / user / code ids): the run id's
// tail + a start-time nonce (so a reused PERF_RUN_ID never collides with what an earlier run left in
// the real database) + task / VU / iteration. ≤ 18 chars with a 4-char tag, inside every id limit.
const NONCE = Date.now().toString(36).slice(-4).toUpperCase();
export const uid = (vu, iter) => `${cfg.runId.replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase() || 'LOCL'}${NONCE}${cfg.taskIndex}V${vu}I${iter}`;
