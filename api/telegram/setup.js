import { adminIds, tg, tgToken, tgSecret, siteUrl, installWebhook, safeEqual, sendHtml } from "../_lib/telegram.js";

/**
 * Buka sekali setelah deploy (atau setelah update ini, supaya tombol & daftar perintah aktif):
 *   https://DOMAIN-KAMU/api/telegram/setup?key=NILAI_TELEGRAM_WEBHOOK_SECRET
 * Memasang webhook, mendaftarkan perintah bot, dan mengirim pesan tes ke admin.
 */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const secret = tgSecret();
  if (!secret) return res.status(500).json({ error: "Isi TELEGRAM_WEBHOOK_SECRET di Environment Variables dulu." });
  if (!safeEqual(req.query.key, secret)) return res.status(403).json({ error: "key salah" });
  if (!tgToken()) return res.status(500).json({ error: "TELEGRAM_BOT_TOKEN belum diset." });

  const base = siteUrl(req);
  const inst = await installWebhook(base);
  const info = await tg("getWebhookInfo");
  const admins = adminIds();
  const tests = [];
  for (const chat_id of admins) {
    const r = await sendHtml(chat_id, "✅ Webhook RipBlast terpasang. Bot siap menerima order.\nKetik /menu untuk panel admin atau /help untuk semua perintah.");
    tests.push({ chat_id, ok: !!r.ok, error: r.ok ? undefined : r.description });
  }
  return res.status(inst.set.ok ? 200 : 502).json({
    webhook_url: inst.url,
    setWebhook: inst.set,
    commands_registered: inst.commands.every((c) => c.ok),
    webhook_info: info.result,
    admin_chat_ids: admins,
    test_messages: tests,
    note: admins.length ? undefined : "TELEGRAM_ADMIN_CHAT_ID belum diset: kirim /start ke bot untuk melihat Chat ID-mu.",
  });
}
