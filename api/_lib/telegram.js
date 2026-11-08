import { db } from "./db.js";
import { esc, rp, wib, clip } from "./fmt.js";
import { COUNTRIES } from "./settings.js";
import { orderRef, stageOf, isClosedStage, STAGE_LABEL, otpCode } from "./orders.js";
import { timingSafeEqual } from "node:crypto";

export const tgToken = () => process.env.TELEGRAM_BOT_TOKEN;
export const tgSecret = () => process.env.TELEGRAM_WEBHOOK_SECRET;

export function adminIds() {
  return (process.env.TELEGRAM_ADMIN_CHAT_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

/* ---------- Panggilan API ---------- */

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

export async function tgDocument(chat_id, filename, content, caption = "") {
  const token = tgToken();
  if (!token) return { ok: false, description: "TELEGRAM_BOT_TOKEN belum diset" };
  try {
    const fd = new FormData();
    fd.append("chat_id", String(chat_id));
    if (caption) fd.append("caption", caption.slice(0, 900));
    fd.append("document", new Blob([content], { type: "text/csv" }), filename);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: "POST",
      body: fd,
      signal: AbortSignal.timeout(15000),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, description: String(e?.message || e) };
  }
}

/** Kirim pesan HTML. Teks dipotong aman di bawah batas 4096 karakter Telegram. */
export const sendHtml = (chat_id, text, extra = {}) =>
  tg("sendMessage", { chat_id, text: clip(text, 4000), parse_mode: "HTML", disable_web_page_preview: true, ...extra });

export async function sendAdmins(text, extra = {}) {
  const ids = adminIds();
  return Promise.all(ids.map((chat_id) => sendHtml(chat_id, text, extra)));
}

export const btn = (text, data) => ({ text, callback_data: data });

/* ---------- Kartu order di chat admin ---------- */

export function orderCard(o, username, { hint = true, history = null } = {}) {
  const stage = stageOf(o);
  const cc = COUNTRIES[o.country]?.code ? ` (${COUNTRIES[o.country].code})` : "";
  const lines = [
    `🧾 <b>Order #${orderRef(o.id)}</b> · ${STAGE_LABEL[stage]}`,
    `👤 <code>${esc(username)}</code>${history ? ` · ${esc(history)}` : ""}`,
    `🌍 ${esc(o.country)}${cc} × ${o.quantity} · <b>${rp(o.price ?? 0)}</b>`,
    `📝 ${esc(o.note || "-")}`,
    `🕐 ${wib(o.created_at || Date.now())}`,
    "",
    `📌 Status: ${esc(o.status_text || "-")}`,
    `📱 No: ${o.phone ? `<code>${esc(o.phone)}</code>` : "-"}`,
    `🔢 OTP: ${o.otp ? (otpCode(o.otp) ? `<code>${esc(otpCode(o.otp))}</code>` : esc(o.otp)) : "-"}`,
  ];
  if (o.admin_note) lines.push(`💬 Pesan ke user: ${esc(o.admin_note)}`);
  if (hint && !isClosedStage(stage)) {
    lines.push("", "<i>Pakai tombol di bawah, atau reply pesan ini:</i>", "<code>Status: Sukses✅ (tunggu 1-2 minute)\nNo: 62856xxxxx\nOtp: menunggu🔄</code>");
  }
  return lines.join("\n");
}

export function orderKeyboard(o) {
  const id = o.id;
  if (isClosedStage(stageOf(o))) {
    return { inline_keyboard: [[btn("🔄 Buka lagi", `o:${id}:r`), btn("👤 User", `o:${id}:u`)]] };
  }
  return {
    inline_keyboard: [
      [btn("⏳ Proses", `o:${id}:p`), btn("📱 Isi nomor", `o:${id}:n`), btn("🔢 Isi OTP", `o:${id}:t`)],
      [btn("✅ Selesai", `o:${id}:d`), btn("❌ Gagal", `o:${id}:f`), btn("👤 User", `o:${id}:u`)],
    ],
  };
}

/** Simpan pesan order per chat (maks 3 terbaru) supaya bisa disinkronkan saat status berubah. */
export async function rememberMessage(q, orderId, chatId, messageId) {
  await q`INSERT INTO order_msgs (order_id, chat_id, message_id) VALUES (${orderId}, ${String(chatId)}, ${messageId})
          ON CONFLICT (order_id, chat_id, message_id) DO NOTHING`;
  await q`DELETE FROM order_msgs WHERE order_id = ${orderId} AND chat_id = ${String(chatId)} AND message_id NOT IN (
            SELECT message_id FROM order_msgs WHERE order_id = ${orderId} AND chat_id = ${String(chatId)} ORDER BY message_id DESC LIMIT 3)`;
}

/** Kirim kartu order baru ke semua admin. Mengembalikan jumlah admin yang berhasil dikirimi. */
export async function notifyNewOrder(q, order, username, history) {
  const ids = adminIds();
  if (!ids.length) return { sent: 0, firstMessageId: null };
  const text = orderCard(order, username, { history });
  const markup = orderKeyboard(order);
  const results = await Promise.all(ids.map((chat_id) => sendHtml(chat_id, text, { reply_markup: markup })));
  let sent = 0;
  let first = null;
  for (let i = 0; i < ids.length; i++) {
    const r = results[i];
    if (r?.ok) {
      sent++;
      first ??= r.result.message_id;
      await rememberMessage(q, order.id, ids[i], r.result.message_id);
    } else {
      console.error("sendMessage gagal:", ids[i], r?.description);
    }
  }
  return { sent, firstMessageId: first };
}

/** Perbarui semua kartu order yang pernah dikirim agar status terbaru tampil di chat admin. */
export async function syncOrderCards(q, order) {
  const [u] = await q`SELECT username FROM users WHERE id = ${order.user_id}`;
  const rows = await q`SELECT chat_id, message_id FROM order_msgs WHERE order_id = ${order.id}`;
  const text = orderCard(order, u?.username ?? "?");
  const reply_markup = orderKeyboard(order);
  await Promise.all(
    rows.map(async (r) => {
      const res = await tg("editMessageText", {
        chat_id: r.chat_id,
        message_id: Number(r.message_id),
        text,
        parse_mode: "HTML",
        reply_markup,
      });
      if (!res.ok && !/not modified/i.test(res.description || "")) console.error("editMessageText:", res.description);
    })
  );
}

/* ---------- Webhook & daftar perintah ---------- */

const WEBHOOK_V = "4";
export const ALLOWED_UPDATES = ["message", "edited_message", "callback_query"];

export const ADMIN_COMMANDS = [
  ["menu", "Panel utama"],
  ["pending", "Antrian order aktif"],
  ["stats", "Statistik & omzet"],
  ["order", "Detail order: /order RB-0001"],
  ["find", "Cari user atau order"],
  ["users", "User terbaru"],
  ["proses", "Proses order, nomor diambil random dari stock"],
  ["done", "Sukses: /done 62856xxxx 123456"],
  ["stock", "Tambah stock nomor (kirim banyak, satu per baris)"],
  ["otp", "Isi OTP: /otp RB-0001 123456"],
  ["no", "Isi nomor manual: /no RB-0001 62856..."],
  ["selesai", "Tutup order tanpa OTP"],
  ["gagal", "Tandai gagal"],
  ["pesan", "Pesan ke user di web"],
  ["settings", "Harga, stok, mode, pengumuman"],
  ["export", "Ekspor order ke CSV"],
  ["resetpw", "Reset password user"],
  ["ban", "Blokir user"],
  ["unban", "Buka blokir user"],
  ["health", "Cek sistem"],
  ["help", "Daftar perintah lengkap"],
];

export function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return host ? `https://${host}` : null;
}

export async function installWebhook(base) {
  const url = `${base}/api/telegram/webhook`;
  const body = { url, allowed_updates: ALLOWED_UPDATES };
  if (tgSecret()) body.secret_token = tgSecret();
  const set = await tg("setWebhook", body);
  const cmds = [];
  if (set.ok) {
    cmds.push(await tg("setMyCommands", { commands: [{ command: "start", description: "Mulai / lihat Chat ID" }] }));
    for (const chat_id of adminIds()) {
      cmds.push(
        await tg("setMyCommands", {
          scope: { type: "chat", chat_id: /^-?\d+$/.test(chat_id) ? Number(chat_id) : chat_id },
          commands: ADMIN_COMMANDS.map(([command, description]) => ({ command, description })),
        })
      );
    }
  }
  return { url, set, commands: cmds };
}

/** Pasang webhook otomatis (sekali per URL/token/versi). Hanya di production atau kalau SITE_URL diset. */
export async function ensureWebhook(req) {
  const token = tgToken();
  if (!token) return;
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production" && !process.env.SITE_URL) return;
  const base = siteUrl(req);
  if (!base) return;
  const fingerprint = `${base}/api/telegram/webhook|${token.slice(-8)}|${tgSecret() ? "s" : "-"}|v${WEBHOOK_V}|${adminIds().join(",")}`;
  const q = await db();
  const rows = await q`SELECT value FROM settings WHERE key = 'webhook_url'`;
  if (rows[0]?.value === fingerprint) return;
  const r = await installWebhook(base);
  if (r.set?.ok) {
    await q`INSERT INTO settings (key, value) VALUES ('webhook_url', ${fingerprint})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  } else {
    console.error("setWebhook gagal:", r.set?.description);
  }
}
