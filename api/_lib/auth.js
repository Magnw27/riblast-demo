import { scrypt as scryptCb, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { db } from "./db.js";
import { parseCookies, SESSION_COOKIE, SESSION_DAYS } from "./http.js";

const scrypt = promisify(scryptCb);

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

/** Hash palsu supaya waktu respons login sama baik username ada maupun tidak. */
let dummy = null;
export async function burnPasswordTime(pw) {
  dummy ??= await hashPassword("rb-dummy-password");
  await verifyPassword(pw, dummy);
}

export async function createSession(userId) {
  const q = await db();
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await q`INSERT INTO sessions (token, user_id, expires_at) VALUES (${token}, ${userId}, ${expiresAt})`;
  await q`UPDATE users SET last_login_at = ${new Date().toISOString()} WHERE id = ${userId}`;
  if (Math.random() < 0.1) await q`DELETE FROM sessions WHERE expires_at < ${new Date().toISOString()}`;
  return token;
}

export async function destroySession(token) {
  const q = await db();
  await q`DELETE FROM sessions WHERE token = ${token}`;
}

/** User dari cookie sesi. Akun yang diblokir dianggap tidak login. */
export async function getUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const q = await db();
  const rows = await q`
    SELECT u.id, u.username, u.created_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ${token} AND s.expires_at > ${new Date().toISOString()} AND u.banned = false
    LIMIT 1`;
  return rows[0] ?? null;
}

export const randomPassword = (len = 10) => {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
};
