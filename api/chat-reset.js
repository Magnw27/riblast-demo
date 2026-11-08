import { db } from "./_lib/db.js";
import { send, serverError } from "./_lib/http.js";

export default async function handler(req, res) {
  try {
    const isCron = req.headers["x-vercel-cron"] === "1";
    const authorized = process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
    if (!isCron && !authorized) return send(res, 401, { error: "Unauthorized" });
    if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

    const q = await db();
    const result = await q`DELETE FROM chat_messages WHERE created_at < now() - interval '24 hours'`;
    return send(res, 200, { ok: true, deleted: result.length ?? 0 });
  } catch (error) {
    return serverError(res, error, "chat-reset");
  }
}
