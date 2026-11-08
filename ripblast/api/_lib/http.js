import { db } from "./db.js";

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

export const SESSION_COOKIE = "rb_session";
export const SESSION_DAYS = 30;

const isHttps = (req) => req.headers["x-forwarded-proto"] === "https" || process.env.VERCEL_ENV === "production";

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

export function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || String(req.headers["x-real-ip"] || "") || "unknown";
}

/** Tolak request tulis dari situs lain (pertahanan CSRF tambahan di atas SameSite=Lax). */
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Pembatas laju berbasis database (bekerja lintas instance serverless).
 * Mengembalikan { ok, n, retryAfter }.
 */
export async function rateLimit(key, max, windowSec) {
  const q = await db();
  const now = new Date();
  const nowIso = now.toISOString();
  const resetIso = new Date(now.getTime() + windowSec * 1000).toISOString();
  const [row] = await q`
    INSERT INTO rate_limits (key, n, reset_at) VALUES (${key}, 1, ${resetIso})
    ON CONFLICT (key) DO UPDATE SET
      n = CASE WHEN rate_limits.reset_at < ${nowIso} THEN 1 ELSE rate_limits.n + 1 END,
      reset_at = CASE WHEN rate_limits.reset_at < ${nowIso} THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
    RETURNING n, reset_at`;
  if (Math.random() < 0.02) await q`DELETE FROM rate_limits WHERE reset_at < ${nowIso}`;
  const retryAfter = Math.max(1, Math.ceil((new Date(row.reset_at).getTime() - now.getTime()) / 1000));
  return { ok: Number(row.n) <= max, n: Number(row.n), retryAfter };
}

export function waitText(sec) {
  return sec >= 90 ? `${Math.ceil(sec / 60)} menit` : `${sec} detik`;
}
