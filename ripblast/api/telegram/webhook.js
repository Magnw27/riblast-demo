import { tgToken, tgSecret, safeEqual } from "../_lib/telegram.js";
import { handleMessage, handleCallback } from "../_lib/bot.js";

export default async function handler(req, res) {
  // Telegram butuh 200 cepat; error apa pun tetap dijawab 200 agar tidak di-retry terus.
  if (req.method !== "POST") return res.status(200).send("ok");

  const secret = tgSecret();
  if (secret && !safeEqual(req.headers["x-telegram-bot-api-secret-token"], secret)) {
    return res.status(403).send("forbidden");
  }
  if (!tgToken()) return res.status(200).send("bot not configured");

  try {
    const update = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    if (update.callback_query) {
      await handleCallback(update.callback_query);
    } else {
      const msg = update.message || update.edited_message;
      if (msg?.text) await handleMessage(msg);
    }
  } catch (e) {
    console.error("webhook error:", e);
  }
  return res.status(200).send("ok");
}
