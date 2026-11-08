import { db } from "./_lib/db.js";
import { getUser } from "./_lib/auth.js";
import { send, serverError, readBody, sameOrigin, rateLimit } from "./_lib/http.js";

const MAX = 4000;

export default async function handler(req, res) {
  try {
    const user = await getUser(req);
    if (!user) return send(res, 401, { error: "Silakan login untuk masuk chat." });
    const q = await db();
    // Fallback cleanup keeps retention bounded even if the daily cron has not run yet.
    await q`DELETE FROM chat_messages WHERE created_at < now() - interval '24 hours'`;
    if (req.method === "GET") {
      const before = Number(req.query.before) || 0;
      const rows = before
        ? await q`SELECT id, sender_name, sender_kind, body, created_at FROM chat_messages WHERE id < ${before} ORDER BY id DESC LIMIT 50`
        : await q`SELECT id, sender_name, sender_kind, body, created_at FROM chat_messages ORDER BY id DESC LIMIT 50`;
      const settings = await q`SELECT key, value FROM settings WHERE key IN ('popup', 'announce')`;
      const notices = Object.fromEntries(settings.map((item) => [item.key, item.value]));
      return send(res, 200, { messages: rows.reverse(), popup: notices.popup || '', announce: notices.announce || '' });
    }
    if (req.method !== "POST" || !sameOrigin(req)) return send(res, 405, { error: "Method not allowed" });
    const rl = await rateLimit(`chat:${user.id}`, 20, 60);
    if (!rl.ok) return send(res, 429, { error: "Terlalu cepat. Tunggu sebentar." });
    const body = readBody(req);
    const text = String(body.body ?? "").trim().slice(0, MAX);
    if (!text) return send(res, 400, { error: "Pesan tidak boleh kosong." });
    const [message] = await q`INSERT INTO chat_messages (sender_user_id, sender_name, sender_kind, body) VALUES (${user.id}, ${user.username}, 'user', ${text}) RETURNING id, sender_name, sender_kind, body, created_at`;
    return send(res, 201, { message });
  } catch (e) {
    return serverError(res, e, "chat");
  }
}
