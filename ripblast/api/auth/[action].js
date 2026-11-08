import { db } from "../_lib/db.js";
import {
  send, serverError, readBody, parseCookies, setSessionCookie, clearSessionCookie, SESSION_COOKIE,
  sameOrigin, clientIp, rateLimit, waitText,
} from "../_lib/http.js";
import { hashPassword, verifyPassword, burnPasswordTime, createSession, destroySession, getUser } from "../_lib/auth.js";
import { allSettings } from "../_lib/settings.js";
import { adminIds, sendAdmins } from "../_lib/telegram.js";
import { esc } from "../_lib/fmt.js";

const USERNAME_RE = /^[a-z0-9_.]{3,24}$/;
const userOut = (u) => ({ id: u.id, username: u.username });

export default async function handler(req, res) {
  try {
    const action = String(req.query.action || "");

    if (action === "me") {
      const user = await getUser(req);
      return send(res, 200, { user: user ? userOut(user) : null });
    }

    if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
    if (!sameOrigin(req)) return send(res, 403, { error: "Permintaan ditolak." });

    if (action === "logout") {
      const token = parseCookies(req)[SESSION_COOKIE];
      if (token) await destroySession(token);
      clearSessionCookie(req, res);
      return send(res, 200, { ok: true });
    }

    const body = readBody(req);
    const q = await db();

    if (action === "password") {
      const user = await getUser(req);
      if (!user) return send(res, 401, { error: "Silakan login dulu." });
      const current = String(body.current ?? "");
      const next = String(body.next ?? "");
      if (next.length < 6 || next.length > 200) return send(res, 400, { error: "Password baru minimal 6 karakter." });
      const rl = await rateLimit(`pw:${user.id}`, 6, 600);
      if (!rl.ok) return send(res, 429, { error: `Terlalu banyak percobaan. Coba lagi dalam ${waitText(rl.retryAfter)}.` });
      const [row] = await q`SELECT password_hash FROM users WHERE id = ${user.id}`;
      if (!row || !(await verifyPassword(current, row.password_hash))) return send(res, 401, { error: "Password lama salah." });
      await q`UPDATE users SET password_hash = ${await hashPassword(next)} WHERE id = ${user.id}`;
      // Keluarkan perangkat lain, pertahankan sesi ini.
      const keep = parseCookies(req)[SESSION_COOKIE];
      await q`DELETE FROM sessions WHERE user_id = ${user.id} AND token <> ${keep}`;
      return send(res, 200, { ok: true });
    }

    if (action !== "register" && action !== "login") return send(res, 404, { error: "Aksi tidak dikenal" });

    const username = String(body.username ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!USERNAME_RE.test(username))
      return send(res, 400, { error: "Username 3-24 karakter, hanya huruf kecil, angka, titik, underscore." });
    if (password.length < 6 || password.length > 200) return send(res, 400, { error: "Password minimal 6 karakter." });

    const ip = clientIp(req);
    const limits =
      action === "register"
        ? [[`reg:ip:${ip}`, 6, 3600]]
        : [[`login:ip:${ip}`, 30, 600], [`login:u:${username}`, 10, 600]];
    for (const [key, max, win] of limits) {
      const rl = await rateLimit(key, max, win);
      if (!rl.ok) return send(res, 429, { error: `Terlalu banyak percobaan. Coba lagi dalam ${waitText(rl.retryAfter)}.` });
    }

    if (action === "register") {
      const exists = await q`SELECT 1 FROM users WHERE username = ${username} LIMIT 1`;
      if (exists.length) return send(res, 409, { error: "Username sudah dipakai, coba yang lain." });
      const hash = await hashPassword(password);
      let user;
      try {
        [user] = await q`INSERT INTO users (username, password_hash) VALUES (${username}, ${hash}) RETURNING id, username`;
      } catch (e) {
        if (e?.code === "23505") return send(res, 409, { error: "Username sudah dipakai, coba yang lain." });
        throw e;
      }
      setSessionCookie(req, res, await createSession(user.id));
      // Notifikasi opsional ke admin (diatur lewat /notif di bot).
      try {
        if (adminIds().length && (await allSettings(q)).notify_register === "1") {
          await sendAdmins(`👤 User baru daftar: <code>${esc(user.username)}</code>`);
        }
      } catch (e) {
        console.error("notify register:", e);
      }
      return send(res, 201, { user: userOut(user) });
    }

    // login
    const [user] = await q`SELECT id, username, password_hash, banned FROM users WHERE username = ${username} LIMIT 1`;
    if (!user) {
      await burnPasswordTime(password);
      return send(res, 401, { error: "Username atau password salah." });
    }
    if (!(await verifyPassword(password, user.password_hash))) return send(res, 401, { error: "Username atau password salah." });
    if (user.banned) return send(res, 403, { error: "Akun ini dinonaktifkan. Hubungi admin lewat WhatsApp." });
    setSessionCookie(req, res, await createSession(user.id));
    return send(res, 200, { user: userOut(user) });
  } catch (e) {
    return serverError(res, e, "auth");
  }
}
