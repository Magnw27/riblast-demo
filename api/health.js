import { db, findDbEnv, SCHEMA_V } from "./_lib/db.js";
import { tgToken, tgSecret, adminIds } from "./_lib/telegram.js";

/** Buka https://DOMAINMU/api/health untuk melihat konfigurasi mana yang belum beres (tanpa menampilkan nilai rahasia). */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const found = findDbEnv();
  const out = {
    database_env: found ? found.key : null,
    database: "belum dicek",
    schema: SCHEMA_V,
    telegram_bot_token: !!tgToken(),
    telegram_admin_chat_id: adminIds().length > 0,
    telegram_webhook_secret: !!tgSecret(),
    vercel_env: process.env.VERCEL_ENV || null,
  };
  if (!found) {
    out.database = "GAGAL";
    out.hint = "Tidak ada variabel DATABASE_URL / POSTGRES_URL berisi postgres://... di environment ini. Tambahkan di Settings > Environment Variables (centang Production), lalu Redeploy.";
    return res.status(500).json(out);
  }
  try {
    const q = await db();
    await q`SELECT 1 AS ok`;
    out.database = "OK";
    return res.status(200).json(out);
  } catch (e) {
    out.database = "GAGAL";
    out.error = String(e?.message || e).replace(/postgres(ql)?:\/\/\S+/gi, "[url]").slice(0, 300);
    return res.status(500).json(out);
  }
}
