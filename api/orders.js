import { db } from "./_lib/db.js";
import { send, serverError, readBody, sameOrigin, rateLimit, waitText } from "./_lib/http.js";
import { getUser } from "./_lib/auth.js";
import { allSettings, COUNTRIES, priceOf, inStock, isMaintenance } from "./_lib/settings.js";
import { publicOrder, logEvent, eventsForUser, orderRef } from "./_lib/orders.js";
import { adminIds, notifyNewOrder, ensureWebhook, syncOrderCards, sendAdmins } from "./_lib/telegram.js";
import { esc } from "./_lib/fmt.js";

const MAX_PENDING = 5;
const PAGE = 20;

export default async function handler(req, res) {
  try {
    const user = await getUser(req);
    if (!user) return send(res, 401, { error: "Silakan login dulu." });
    const q = await db();

    if (req.method === "GET") return await list(req, res, q, user);
    if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
    if (!sameOrigin(req)) return send(res, 403, { error: "Permintaan ditolak." });

    const body = readBody(req);
    if (body.action === "cancel") return await cancel(res, q, user, body);
    return await create(req, res, q, user, body);
  } catch (e) {
    return serverError(res, e, "orders");
  }
}

/** Daftar order + ringkasan. Kalau `rev` sama dengan kondisi terkini, balas ringan tanpa data. */
async function list(req, res, q, user) {
  const before = Number(req.query.before) || 0;
  const [sum] = await q`
    SELECT count(*)::int AS total,
      COALESCE(sum(CASE WHEN status IN ('pending', 'processing') OR (status = 'done' AND closed_at IS NULL) THEN 1 ELSE 0 END), 0)::int AS active,
      COALESCE(sum(CASE WHEN status = 'done' AND closed_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS done,
      COALESCE(max(id), 0)::int AS max_id,
      max(updated_at) AS max_upd
    FROM orders WHERE user_id = ${user.id}`;
  const summary = { total: sum.total, active: sum.active, done: sum.done };
  const rev = `${sum.total}-${sum.max_id}-${sum.max_upd ? new Date(sum.max_upd).getTime() : 0}`;
  if (!before && req.query.rev === rev) return send(res, 200, { unchanged: true, rev, summary });

  const rows = before
    ? await q`SELECT * FROM orders WHERE user_id = ${user.id} AND id < ${before} ORDER BY id DESC LIMIT ${PAGE + 1}`
    : await q`SELECT * FROM orders WHERE user_id = ${user.id} ORDER BY id DESC LIMIT ${PAGE + 1}`;
  const hasMore = rows.length > PAGE;
  const page = rows.slice(0, PAGE);
  const events = page.length ? await eventsForUser(q, user.id, page[page.length - 1].id, page[0].id) : new Map();
  return send(res, 200, { orders: page.map((o) => publicOrder(o, events.get(o.id) || [])), hasMore, rev, summary });
}

async function create(req, res, q, user, body) {
  const country = String(body.country ?? "").trim();
  const quantity = Math.min(Math.max(Math.floor(Number(body.quantity) || 1), 1), 10);
  const note = String(body.note ?? "").trim().slice(0, 300);
  if (!COUNTRIES[country]) return send(res, 400, { error: "Pilih negara nomor." });

  const settings = await allSettings(q);
  if (isMaintenance(settings)) {
    return send(res, 503, { error: settings.maintenance_msg ? `Order ditutup sementara: ${settings.maintenance_msg}` : "Order ditutup sementara. Coba lagi sebentar lagi." });
  }
  if (!inStock(settings, country)) return send(res, 409, { error: `Stok nomor ${country} sedang habis. Pilih negara lain atau coba lagi nanti.` });

  const rl = await rateLimit(`order:${user.id}`, 8, 600);
  if (!rl.ok) return send(res, 429, { error: `Terlalu banyak order beruntun. Coba lagi dalam ${waitText(rl.retryAfter)}.` });

  const [{ n }] = await q`SELECT count(*)::int AS n FROM orders WHERE user_id = ${user.id} AND status = 'pending'`;
  if (n >= MAX_PENDING) return send(res, 429, { error: `Masih ada ${n} order yang menunggu admin. Tunggu diproses dulu ya.` });

  const price = priceOf(settings, country) * quantity;
  const [order] = await q`
    INSERT INTO orders (user_id, country, quantity, note, price)
    VALUES (${user.id}, ${country}, ${quantity}, ${note}, ${price})
    RETURNING *`;
  await logEvent(q, order.id, "created");

  // Kirim kartu order ke bot Telegram admin (dengan tombol aksi)
  let notified = false;
  if (adminIds().length) {
    await ensureWebhook(req).catch((e) => console.error("ensureWebhook:", e));
    const [h] = await q`SELECT count(*)::int AS total,
        COALESCE(sum(CASE WHEN status = 'done' AND closed_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS done
      FROM orders WHERE user_id = ${user.id}`;
    const r = await notifyNewOrder(q, order, user.username, `${h.total} order, ${h.done} sukses`);
    notified = r.sent > 0;
    if (r.firstMessageId != null) await q`UPDATE orders SET tg_message_id = ${r.firstMessageId} WHERE id = ${order.id}`;
  } else {
    console.error("TELEGRAM_ADMIN_CHAT_ID belum diset, order tidak dikirim ke bot.");
  }

  const pub = publicOrder(order);
  return send(res, 201, { order: pub, ref: pub.ref, notified });
}

/** User membatalkan order yang belum disentuh admin. */
async function cancel(res, q, user, body) {
  const id = Number(body.id);
  if (!id) return send(res, 400, { error: "Order tidak valid." });
  const [o] = await q`UPDATE orders SET status = 'cancelled', status_text = 'Dibatalkan🚫',
      closed_at = ${new Date().toISOString()}, updated_at = ${new Date().toISOString()}
    WHERE id = ${id} AND user_id = ${user.id} AND status = 'pending'
    RETURNING *`;
  if (!o) return send(res, 409, { error: "Order tidak bisa dibatalkan (sudah diproses admin atau tidak ditemukan)." });
  await logEvent(q, id, "cancelled", "dibatalkan user");
  try {
    if (adminIds().length) {
      await syncOrderCards(q, o);
      await sendAdmins(`🚫 <code>${esc(user.username)}</code> membatalkan order <b>#${orderRef(id)}</b>.`);
    }
  } catch (e) {
    console.error("cancel notify:", e);
  }
  return send(res, 200, { order: publicOrder(o) });
}
