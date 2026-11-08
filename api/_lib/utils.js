import { scrypt as scryptCb, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { db } from "./db.js";

const scrypt = promisify(scryptCb);

export const SESSION_COOKIE = "rb_session";
const SESSION_DAYS = 30;

export const COUNTRIES = {
  Indonesia: "+62",
  Malaysia: "+60",
  Inggris: "+44",
  "Amerika Serikat": "+1",
};

/* ---------- HTTP helpers ---------- */

export function send(res, status, data) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(data);
}

/** Jawaban 500 yang menyertakan penyebab (URL/password database disamarkan). */
export function serverError(res, e, where) {
  console.error(where + " error:", e);
  const detail = String(e?.message || e)
    .replace(/postgres(ql)?:\/\/\S+/gi, "[url]")
    .slice(0, 200);
  return send(res, 500, { error: `Server bermasalah: ${detail}` });
}

export function readBody(req) {
  const b = req.body;
  if (b && typeof b === "object" && !Buffer.isBuffer(b)) return b;
  if (typeof b === "string") {
    try {
      return JSON.parse(b);
    } catch {
      return {};
    }
  }
  return {};
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* cookie rusak, abaikan */
    }
  }
  return out;
}

function isHttps(req) {
  return req.headers["x-forwarded-proto"] === "https" || process.env.VERCEL_ENV === "production";
}

export function setSessionCookie(req, res, token) {
  const parts = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_DAYS * 86400}`];
  if (isHttps(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(req, res) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isHttps(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

/* ---------- Password & sesi ---------- */

export async function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(pw, salt, 64);
  return `${salt}:${key.toString("hex")}`;
}

export async function verifyPassword(pw, stored) {
  const [salt, key] = String(stored).split(":");
  if (!salt || !key) return false;
  const a = Buffer.from(key, "hex");
  const b = await scrypt(pw, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createSession(userId) {
  const q = await db();
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await q`INSERT INTO sessions (token, user_id, expires_at) VALUES (${token}, ${userId}, ${expiresAt})`;
  // bersihkan sesi kedaluwarsa sesekali
  if (Math.random() < 0.1) await q`DELETE FROM sessions WHERE expires_at < now()`;
  return token;
}

export async function destroySession(token) {
  const q = await db();
  await q`DELETE FROM sessions WHERE token = ${token}`;
}

export async function getUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const q = await db();
  const rows = await q`
    SELECT u.id, u.username
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ${token} AND s.expires_at > now()
    LIMIT 1`;
  return rows[0] ?? null;
}

/* ---------- Format order ---------- */

export function orderRef(id) {
  return `RB-${String(id).padStart(4, "0")}`;
}

export function publicOrder(o) {
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  return {
    id: o.id,
    ref: orderRef(o.id),
    country: o.country,
    quantity: o.quantity,
    note: o.note,
    status: o.status,
    statusText: o.status_text,
    phone: o.phone,
    otp: o.otp,
    createdAt: iso(o.created_at),
    updatedAt: iso(o.updated_at),
  };
}

/* ---------- Telegram ---------- */

export const tgToken = () => process.env.TELEGRAM_BOT_TOKEN;
export const tgSecret = () => process.env.TELEGRAM_WEBHOOK_SECRET;

export function adminIds() {
  return (process.env.TELEGRAM_ADMIN_CHAT_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function tg(method, body = {}) {
  const token = tgToken();
  if (!token) return { ok: false, description: "TELEGRAM_BOT_TOKEN belum diset" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, description: String(e?.message || e) };
  }
}

export function orderText(o, username) {
  const cc = COUNTRIES[o.country] ? ` (${COUNTRIES[o.country]})` : "";
  const t = new Date(o.created_at || Date.now()).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  return [
    `🔔 Order baru #${orderRef(o.id)}`,
    `👤 User: ${username}`,
    `🌍 Negara: ${o.country}${cc}`,
    `🔢 Jumlah: ${o.quantity}`,
    `📝 Catatan: ${o.note || "-"}`,
    `🕐 Waktu: ${t} WIB`,
    "",
    "Balas (reply) pesan ini dengan format:",
    "Status: Sukses✅ (tunggu 1-2 minute)",
    "No: 62856xxxxx",
    "Otp: menunggu🔄",
    "",
    "Setelah OTP masuk, reply lagi cukup dengan:",
    "Otp: 123456",
  ].join("\n");
}

/** Kategori status dari teks bebas admin. */
export function categorize(statusText) {
  if (/gagal|fail|batal|cancel|tolak|habis|refund|❌/i.test(statusText)) return "failed";
  if (/sukses|success|berhasil|done|selesai|✅/i.test(statusText)) return "done";
  return "processing";
}

/**
 * Membaca balasan admin. Mendukung beberapa baris:
 *   Status: Sukses✅ (tunggu 1-2 minute)
 *   No: 62856xxxxx
 *   Otp: menunggu🔄
 * maupun satu baris ("Status: Done no: +62856xxxxx otp: 123456").
 * Field yang tidak ditulis admin dikembalikan null (tidak menimpa data lama).
 */
export function parseAdminReply(text) {
  const src = String(text ?? "");
  const re = /(?<![\p{L}\p{N}])(status|nomor|no|otp)\s*[:=]/giu;
  const marks = [];
  let m;
  while ((m = re.exec(src))) marks.push({ key: m[1].toLowerCase(), start: m.index, end: m.index + m[0].length });

  const out = { statusText: null, phone: null, otp: null };
  marks.forEach((mk, i) => {
    const next = marks[i + 1]?.start ?? src.length;
    const value = src.slice(mk.end, next).split("\n")[0].trim();
    if (!value) return;
    if (mk.key === "status") out.statusText = value.slice(0, 120);
    else if (mk.key === "otp") out.otp = value.slice(0, 60);
    else {
      const nums = value.match(/\+?\d[\dxX*\s-]{6,18}[\dxX*]/g);
      if (nums) out.phone = nums.map((n) => n.replace(/[\s-]/g, "")).join(", ").slice(0, 200);
    }
  });
  return out;
}

/** Pasang webhook sekali per deploy URL (hanya di production atau kalau SITE_URL diset). */
export function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return host ? `https://${host}` : null;
}

export async function ensureWebhook(req) {
  const token = tgToken();
  if (!token) return;
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production" && !process.env.SITE_URL) return;
  const base = siteUrl(req);
  if (!base) return;
  const url = `${base}/api/telegram/webhook`;
  const fingerprint = `${url}|${token.slice(-8)}|${tgSecret() ? "s" : "-"}`;
  const q = await db();
  const rows = await q`SELECT value FROM settings WHERE key = 'webhook_url'`;
  if (rows[0]?.value === fingerprint) return;
  const body = { url, allowed_updates: ["message", "edited_message"] };
  if (tgSecret()) body.secret_token = tgSecret();
  const r = await tg("setWebhook", body);
  if (r?.ok) {
    await q`INSERT INTO settings (key, value) VALUES ('webhook_url', ${fingerprint})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  } else {
    console.error("setWebhook gagal:", r?.description);
  }
}
