import { COUNTRIES } from "./settings.js";

/* ---------- Kode & parsing ---------- */

export const orderRef = (id) => `RB-${String(id).padStart(4, "0")}`;

/** "RB-0012", "#rb-12", "12" -> 12 */
export function parseRef(text) {
  const m = String(text ?? "").match(/#?RB-0*(\d+)/i) || String(text ?? "").trim().match(/^#?(\d{1,9})$/);
  return m ? Number(m[1]) : null;
}

/** Ambil kode OTP dari teks: "123456", "123-456", "Kode: 4821". */
export function otpCode(text) {
  const m = String(text ?? "").match(/\d{3}[- ]\d{3}|\d{4,8}/);
  return m ? m[0].replace(/[- ]/g, "") : null;
}

export const splitList = (s) => String(s ?? "").split(/\s*,\s*/).filter(Boolean);

/** 199876 -> 199-876 (6 digit dipisah 3-3, selain itu apa adanya). */
export function fmtOtp(raw) {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length === 6 ? `${d.slice(0, 3)}-${d.slice(3)}` : d;
}

/** Pasangkan tiap nomor dengan OTP-nya. Order berisi banyak nomor menyimpan OTP sebagai daftar "a, b" sejajar dengan nomor. */
export function numberItems(phone, otp) {
  const ph = splitList(phone);
  const ot = splitList(otp);
  return ph.map((p, i) => {
    const raw = ot.length === ph.length ? ot[i] : ph.length === 1 ? String(otp ?? "") || null : i === 0 ? ot[0] ?? null : null;
    const code = otpCode(raw);
    const display = code && /^\s*\d{3}[- ]\d{3}\s*$/.test(raw) ? raw.trim().replace(" ", "-") : code;
    return { phone: p, otp: raw || null, otpCode: code, otpDisplay: display };
  });
}

/** Semua nomor dalam order sudah punya kode OTP? (Order 1 nomor: cukup ada kode.) */
export function otpsComplete(phone, otp) {
  const ph = splitList(phone);
  const ot = splitList(otp);
  if (ph.length > 1 && ot.length === ph.length) return ot.every((x) => otpCode(x));
  return !!otpCode(otp);
}

/** Kategori status dari teks bebas admin. */
export function categorize(statusText) {
  if (/gagal|fail|batal|cancel|tolak|habis|refund|❌/i.test(statusText)) return "failed";
  if (/sukses|success|berhasil|done|selesai|✅/i.test(statusText)) return "done";
  return "processing";
}

/**
 * Membaca balasan admin, multi-baris maupun satu baris:
 *   Status: Sukses✅ (tunggu 1-2 minute)
 *   No: 62856xxxxx
 *   Otp: menunggu🔄
 *   Pesan: teks untuk user
 * Field yang tidak ditulis dikembalikan null (tidak menimpa data lama).
 */
export function parseAdminReply(text) {
  const src = String(text ?? "");
  const re = /(?<![\p{L}\p{N}])(status|nomor|number|no|hp|otp|kode|code|pesan|catatan|note)\s*[:=]/giu;
  const marks = [];
  let m;
  while ((m = re.exec(src))) marks.push({ key: m[1].toLowerCase(), end: m.index + m[0].length, start: m.index });

  const out = { statusText: null, phone: null, otp: null, note: null };
  marks.forEach((mk, i) => {
    const next = marks[i + 1]?.start ?? src.length;
    const value = src.slice(mk.end, next).split("\n")[0].trim();
    if (!value) return;
    if (mk.key === "status") out.statusText = value.slice(0, 120);
    else if (["otp", "kode", "code"].includes(mk.key)) out.otp = value.slice(0, 60);
    else if (["pesan", "catatan", "note"].includes(mk.key)) out.note = value.slice(0, 300);
    else {
      const nums = value.match(/\+?\d[\dxX*\s-]{6,18}[\dxX*]/g);
      if (nums) out.phone = nums.map((n) => n.replace(/[\s-]/g, "")).join(", ").slice(0, 200);
    }
  });
  return out;
}

/* ---------- Tahap order ---------- */

/** pending -> processing -> ready (nomor sudah ada, tunggu OTP) -> done | failed | cancelled */
export function stageOf(o) {
  if (o.status === "failed" || o.status === "cancelled") return o.status;
  if (o.status === "done") return o.closed_at ? "done" : "ready";
  if (o.status === "processing") return o.phone ? "ready" : "processing";
  return "pending";
}

export const isClosedStage = (st) => st === "done" || st === "failed" || st === "cancelled";

export const STAGE_LABEL = {
  pending: "⏳ Menunggu",
  processing: "🔄 Diproses",
  ready: "📱 Nomor siap, tunggu OTP",
  done: "✅ Selesai",
  failed: "❌ Gagal",
  cancelled: "🚫 Dibatalkan",
};

const iso = (d) => (d ? new Date(d).toISOString() : null);

export function publicOrder(o, events = []) {
  const items = numberItems(o.phone, o.otp);
  return {
    id: o.id,
    ref: orderRef(o.id),
    country: o.country,
    code: COUNTRIES[o.country]?.code ?? "",
    quantity: o.quantity,
    price: o.price ?? null,
    note: o.note,
    status: o.status,
    stage: stageOf(o),
    statusText: o.status_text,
    phone: o.phone,
    otp: o.otp,
    otpCode: items.find((i) => i.otpCode)?.otpCode ?? otpCode(o.otp),
    items,
    adminNote: o.admin_note ?? null,
    createdAt: iso(o.created_at),
    updatedAt: iso(o.updated_at),
    closedAt: iso(o.closed_at),
    events: events.map((e) => ({ kind: e.kind, detail: e.detail ?? null, at: iso(e.created_at) })),
  };
}

/* ---------- Riwayat & pembaruan ---------- */

export async function logEvent(q, orderId, kind, detail = null) {
  await q`INSERT INTO order_events (order_id, kind, detail) VALUES (${orderId}, ${kind}, ${detail})`;
}

/**
 * Satu-satunya pintu untuk mengubah order dari sisi admin (balasan, tombol, perintah).
 * p: { statusText, status, phone, otp, note, close, reopen, raw }
 * Mengembalikan { order, prev, changed, changes } atau null kalau order tidak ada.
 */
export async function applyOrderUpdate(q, id, p = {}) {
  const [o] = await q`SELECT * FROM orders WHERE id = ${id} LIMIT 1`;
  if (!o) return null;
  const now = new Date().toISOString();
  const prevClosed = o.closed_at ? new Date(o.closed_at).toISOString() : null;

  let status = o.status;
  let statusText = p.statusText ?? o.status_text;
  if (p.statusText) status = categorize(p.statusText);
  if (p.status) status = p.status;
  const phone = p.phone ?? o.phone;
  const otp = p.otp ?? o.otp;
  const note = p.note === undefined ? o.admin_note : p.note || null;

  const touched = p.statusText || p.phone || p.otp || p.status || p.close || p.reopen;
  if (status === "pending" && touched) status = "processing";

  let closed = prevClosed;
  if (p.reopen) {
    status = "processing";
    closed = null;
  } else if (p.close) {
    status = "done";
    closed ||= now;
  } else if (status === "failed" || status === "cancelled") {
    closed ||= now;
  } else if (p.otp && otpsComplete(phone, otp)) {
    status = "done";
    closed ||= now;
  } else if (status === "processing" || status === "pending") {
    closed = null;
  }
  // Teks status harus cocok dengan status akhirnya (mis. tombol Selesai setelah "Diproses⏳").
  const cat = statusText ? categorize(statusText) : null;
  if (status === "done" && cat !== "done") statusText = "Selesai✅";
  if (status === "failed" && cat !== "failed") statusText = "Gagal❌";
  if (status === "cancelled") statusText = "Dibatalkan🚫";
  if (status === "processing" && cat !== "processing") statusText = "Diproses⏳";

  const same =
    status === o.status &&
    statusText === o.status_text &&
    phone === o.phone &&
    otp === o.otp &&
    note === o.admin_note &&
    closed === prevClosed;

  const raw = p.raw ? String(p.raw).trim().slice(0, 1000) : o.admin_message;
  const [u] = await q`
    UPDATE orders SET
      status = ${status}, status_text = ${statusText}, phone = ${phone}, otp = ${otp},
      admin_note = ${note}, admin_message = ${raw},
      closed_at = ${closed}::timestamptz, updated_at = ${now}
    WHERE id = ${id}
    RETURNING *`;

  const changes = [];
  if (p.reopen) changes.push(["reopened", null]);
  else if (status !== o.status) changes.push([status, statusText]);
  if (phone !== o.phone && phone) changes.push(["number", phone]);
  if (otp !== o.otp && otpCode(otp)) changes.push(["otp", null]);
  if (note !== o.admin_note && note) changes.push(["note", note]);
  for (const [kind, detail] of changes) await logEvent(q, id, kind, detail);

  return { order: u, prev: o, changed: !same, changes };
}

/** Event untuk sekumpulan order milik user (rentang id), tanpa array parameter. */
export async function eventsForUser(q, userId, minId, maxId) {
  const rows = await q`
    SELECT e.order_id, e.kind, e.detail, e.created_at
    FROM order_events e JOIN orders o ON o.id = e.order_id
    WHERE o.user_id = ${userId} AND o.id >= ${minId} AND o.id <= ${maxId}
    ORDER BY e.id`;
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.order_id)) by.set(r.order_id, []);
    by.get(r.order_id).push(r);
  }
  return by;
}

/** Statistik kecepatan respon admin dari 100 order terakhir (menit). */
export async function responseStats(q) {
  const rows = await q`
    SELECT o.created_at,
      (SELECT min(e.created_at) FROM order_events e WHERE e.order_id = o.id AND e.kind <> 'created') AS first_at
    FROM orders o ORDER BY o.id DESC LIMIT 100`;
  const mins = rows
    .filter((r) => r.first_at)
    .map((r) => (new Date(r.first_at) - new Date(r.created_at)) / 60000)
    .filter((m) => m >= 0)
    .sort((a, b) => a - b);
  if (!mins.length) return { n: 0, avgMin: null, medianMin: null };
  const avg = mins.reduce((a, b) => a + b, 0) / mins.length;
  return { n: mins.length, avgMin: avg, medianMin: mins[Math.floor(mins.length / 2)] };
}
