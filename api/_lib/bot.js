import { db, findDbEnv, SCHEMA_V } from "./db.js";
import { esc, rp, ago, wib, clip, csvCell, startOfDayWib } from "./fmt.js";
import { COUNTRIES, allSettings, setSetting, delSetting, priceOf, inStock, isMaintenance, resolveCountry } from "./settings.js";
import {
  orderRef, parseRef, otpCode, parseAdminReply, applyOrderUpdate, stageOf, isClosedStage, responseStats,
  splitList, fmtOtp, otpsComplete,
} from "./orders.js";
import { hashPassword, randomPassword } from "./auth.js";
import {
  adminIds, tg, tgDocument, sendHtml, btn, orderCard, orderKeyboard, rememberMessage, syncOrderCards, tgToken,
} from "./telegram.js";

const STAGE_ICON = { pending: "⏳", processing: "🔄", ready: "📱", done: "✅", failed: "❌", cancelled: "🚫" };

const HELP = [
  "<b>Panel admin RipBlast</b>",
  "",
  "<b>Order</b>",
  "/pending — antrian aktif (dengan tombol)",
  "/order RB-0001 — kartu order",
  "/orders [pending|done|failed|cancelled] [jumlah]",
  "/proses [RB-0001] — ambil nomor random dari stock, isi Status/Nomor/Otp (tanpa kode = antrian paling lama; <code>ganti</code> untuk nomor baru)",
  "/done 62856xxxxxxx 123456 — Status: Sukses ✅ + OTP (tampil 123-456)",
  "/stock — tambah stock (reply dengan banyak nomor, satu per baris) · /stock lihat · /stock hapus nomor",
  "/otp RB-0001 123456 · /no RB-0001 62856xxxxxxx (manual)",
  "/selesai · /gagal [alasan] · /buka  + kode order",
  "/pesan RB-0001 teks — tampil ke user di web (<code>-</code> untuk hapus)",
  "Atau reply kartu order dengan <code>Status: ... / No: ... / Otp: ... / Pesan: ...</code>",
  "",
  "<b>User</b>",
  "/find nama atau RB-0001 · /users [jumlah]",
  "/ban nama [alasan] · /unban nama · /resetpw nama",
  "",
  "<b>Toko</b>",
  "/settings — panel harga, stok, maintenance",
  "/setprice indo 5000 · /negara us off (buka/tutup negara di web)",
  "/maintenance on [pesan] · /maintenance off",
  "/announce teks · /announce off · /popup teks · /chat teks · /clear", 
  "/notif on|off — notifikasi user baru",
  "",
  "<b>Laporan</b>",
  "/stats · /export [hari] · /health",
].join("\n");

/* ---------- Pencarian & tampilan ---------- */

async function getOrder(q, id) {
  const [o] = await q`SELECT * FROM orders WHERE id = ${id} LIMIT 1`;
  return o ?? null;
}

async function usernameOf(q, userId) {
  const [u] = await q`SELECT username FROM users WHERE id = ${userId}`;
  return u?.username ?? "?";
}

async function userHistory(q, userId) {
  const [r] = await q`SELECT count(*)::int AS total,
      COALESCE(sum(CASE WHEN status = 'done' AND closed_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS done
    FROM orders WHERE user_id = ${userId}`;
  return `${r.total} order, ${r.done} sukses`;
}

async function sendCard(ctx, order) {
  const username = await usernameOf(ctx.q, order.user_id);
  const history = await userHistory(ctx.q, order.user_id);
  const r = await sendHtml(ctx.chatId, orderCard(order, username, { history }), { reply_markup: orderKeyboard(order) });
  if (r?.ok) await rememberMessage(ctx.q, order.id, ctx.chatId, r.result.message_id);
}

function orderLine(o, username) {
  const st = stageOf(o);
  return `${STAGE_ICON[st]} <b>#${orderRef(o.id)}</b> · <code>${esc(username)}</code> · ${esc(o.country)} ×${o.quantity} · ${ago(o.created_at)}`;
}

async function activeOrders(q, limit = 15) {
  return q`SELECT o.*, u.username FROM orders o JOIN users u ON u.id = o.user_id
           WHERE o.status IN ('pending', 'processing') OR (o.status = 'done' AND o.closed_at IS NULL)
           ORDER BY o.id ASC LIMIT ${limit}`;
}

async function queueView(q) {
  const rows = await activeOrders(q);
  if (!rows.length) return { text: "🎉 Tidak ada order aktif. Semua beres.", markup: undefined };
  const [{ n }] = await q`SELECT count(*)::int AS n FROM orders
    WHERE status IN ('pending', 'processing') OR (status = 'done' AND closed_at IS NULL)`;
  const text = [`📋 <b>Antrian aktif</b> (${n})`, "<i>Yang paling lama menunggu di atas.</i>", "", ...rows.map((o) => orderLine(o, o.username))].join("\n");
  const keys = rows.slice(0, 12).map((o) => btn(`#${orderRef(o.id)}`, `o:${o.id}:i`));
  const markup = { inline_keyboard: Array.from({ length: Math.ceil(keys.length / 3) }, (_, i) => keys.slice(i * 3, i * 3 + 3)) };
  return { text, markup };
}

async function statsView(q) {
  const todayIso = startOfDayWib();
  const weekIso = startOfDayWib(Date.now(), 6);
  const group = async (since) => {
    const rows = since
      ? await q`SELECT CASE WHEN status = 'done' AND closed_at IS NULL THEN 'ready' ELSE status END AS st,
                  count(*)::int AS n, COALESCE(sum(price), 0)::int AS rev
                FROM orders WHERE created_at >= ${since} GROUP BY st`
      : await q`SELECT CASE WHEN status = 'done' AND closed_at IS NULL THEN 'ready' ELSE status END AS st,
                  count(*)::int AS n, COALESCE(sum(price), 0)::int AS rev
                FROM orders GROUP BY st`;
    const m = Object.fromEntries(rows.map((r) => [r.st, r]));
    const n = (k) => Number(m[k]?.n ?? 0);
    const total = rows.reduce((a, r) => a + Number(r.n), 0);
    return { total, done: n("done"), failed: n("failed"), cancelled: n("cancelled"), open: n("pending") + n("processing") + n("ready"), rev: Number(m.done?.rev ?? 0) };
  };
  const line = (label, s) =>
    `<b>${label}</b>: ${s.total} order · ✅ ${s.done} · ❌ ${s.failed} · 🚫 ${s.cancelled} · ⏳ ${s.open}\n      💰 omzet ${rp(s.rev)}`;
  const [today, week, all] = [await group(todayIso), await group(weekIso), await group(null)];
  const [u] = await q`SELECT count(*)::int AS total,
      COALESCE(sum(CASE WHEN created_at >= ${todayIso} THEN 1 ELSE 0 END), 0)::int AS today FROM users`;
  const r = await responseStats(q);
  const stockSum = await stockCounts(q);
  const closedAll = all.done + all.failed;
  return [
    "📊 <b>Statistik RipBlast</b>",
    "",
    `👥 User: <b>${u.total}</b> (+${u.today} hari ini)`,
    "",
    line("Hari ini", today),
    line("7 hari", week),
    line("Total", all),
    "",
    `📦 Stok nomor (${stockSum.total}): ${stockLine(stockSum.by)}`,
    closedAll ? `🎯 Tingkat sukses: <b>${Math.round((all.done / closedAll) * 100)}%</b>` : "🎯 Tingkat sukses: belum ada data",
    r.n ? `⚡ Respon pertama: rata-rata <b>${r.avgMin.toFixed(1).replace(".", ",")} mnt</b>, median ${r.medianMin.toFixed(1).replace(".", ",")} mnt (${r.n} order terakhir)` : "⚡ Respon pertama: belum ada data",
  ].join("\n");
}

async function settingsView(q) {
  const s = await allSettings(q);
  const rows = Object.entries(COUNTRIES).map(
    ([name, c]) => `• ${esc(name)} (${c.code}): <b>${rp(priceOf(s, name))}</b> · ${inStock(s, name) ? "✅ tersedia" : "⛔ habis"}`
  );
  const text = [
    "⚙️ <b>Pengaturan toko</b>",
    "",
    `🛠 Maintenance: <b>${isMaintenance(s) ? "ON (order ditutup)" : "OFF"}</b>${s.maintenance_msg ? `\n      <i>${esc(s.maintenance_msg)}</i>` : ""}`,
    `📢 Pengumuman: ${s.announce ? esc(s.announce) : "-"}`,
    `💬 WhatsApp kontak: ${s.wa ? `<code>${esc(s.wa)}</code>` : "-"}`,
    `🔔 Notif user baru: <b>${s.notify_register === "1" ? "ON" : "OFF"}</b>`,
    "",
    "<b>Harga & stok</b>",
    ...rows,
    "",
    "<i>Ubah: /setprice indo 5000 · /negara us off · /announce teks · /wa 628xxx · /maintenance on pesan</i>",
  ].join("\n");
  const stockRow = Object.keys(COUNTRIES).map((name) => btn(`${inStock(s, name) ? "✅" : "⛔"} ${name}`, `k:${name}`));
  const markup = {
    inline_keyboard: [
      [btn(isMaintenance(s) ? "🛠 Maintenance: ON → matikan" : "🛠 Maintenance: OFF → nyalakan", "g:mt")],
      [btn(`🔔 Notif user baru: ${s.notify_register === "1" ? "ON" : "OFF"}`, "g:nr")],
      stockRow.slice(0, 2),
      stockRow.slice(2),
    ],
  };
  return { text, markup };
}

async function healthView(q) {
  const t0 = Date.now();
  let dbLine = "✅ OK";
  try {
    await q`SELECT 1 AS ok`;
    dbLine = `✅ OK (${Date.now() - t0} ms)`;
  } catch (e) {
    dbLine = "❌ " + esc(String(e?.message || e).replace(/postgres(ql)?:\/\/\S+/gi, "[url]").slice(0, 120));
  }
  const info = (await tg("getWebhookInfo")).result || {};
  return [
    "🩺 <b>Cek sistem</b>",
    `Database: ${dbLine} · env <code>${esc(findDbEnv()?.key ?? "tidak ada")}</code>`,
    `Skema: v${SCHEMA_V} · Node ${esc(process.version)}`,
    `Webhook: ${info.url ? "✅ terpasang" : "❌ belum terpasang"}`,
    info.pending_update_count ? `Antrian update Telegram: ${info.pending_update_count}` : null,
    info.last_error_message ? `⚠️ Error terakhir Telegram: ${esc(clip(info.last_error_message, 160))}` : null,
    `Admin terdaftar: ${adminIds().length}`,
  ].filter(Boolean).join("\n");
}

async function userSummary(q, where) {
  const [u] = await where;
  if (!u) return null;
  const [s] = await q`SELECT count(*)::int AS total,
      COALESCE(sum(CASE WHEN status = 'done' AND closed_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS done,
      COALESCE(sum(CASE WHEN status = 'done' AND closed_at IS NOT NULL THEN price ELSE 0 END), 0)::int AS spent
    FROM orders WHERE user_id = ${u.id}`;
  const recent = await q`SELECT * FROM orders WHERE user_id = ${u.id} ORDER BY id DESC LIMIT 5`;
  const text = [
    `👤 <b>${esc(u.username)}</b>${u.banned ? " · 🚫 DIBLOKIR" : ""}`,
    `Daftar: ${wib(u.created_at)}${u.last_login_at ? ` · login terakhir ${ago(u.last_login_at)}` : ""}`,
    `Order: ${s.total} · sukses ${s.done} · belanja ${rp(s.spent)}`,
    recent.length ? "\n<b>Order terbaru</b>\n" + recent.map((o) => orderLine(o, u.username)).join("\n") : "",
  ].join("\n");
  return { text, user: u };
}

/* ---------- Aksi order bersama (perintah, tombol, reply) ---------- */

function fieldsText(o) {
  return [`📌 ${o.status_text || "-"}`, `📱 ${o.phone || "-"}`, `🔢 ${o.otp || "-"}`].map(esc).join(" · ");
}

async function updateAndSync(q, id, patch) {
  const r = await applyOrderUpdate(q, id, patch);
  if (r?.changed) await syncOrderCards(q, r.order);
  return r;
}


/* ---------- Stock nomor & format proses/done ---------- */

const STATUS_PROSES = "proses (tunggu 1-2 menitan)🕘";
const WAIT_OTP = "Menunggu admin🔄";
const STOCK_PROMPT = "Isi nomor yang baru distock";
const FLAG = { Indonesia: "🇮🇩", Malaysia: "🇲🇾", Inggris: "🇬🇧", "Amerika Serikat": "🇺🇸" };

/** "+62 856-1234" -> "628561234"; 0856... -> 62856...; placeholder seperti 62851xxxxx ditolak. */
export function normPhone(raw) {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (/[a-wyz]/i.test(String(raw ?? ""))) return null;
  if (/^0\d{8,12}$/.test(d)) d = "62" + d.slice(1);
  return d.length >= 8 && d.length <= 15 ? d : null;
}

export function countryOfPhone(d) {
  if (d.startsWith("62")) return "Indonesia";
  if (d.startsWith("60")) return "Malaysia";
  if (d.startsWith("44")) return "Inggris";
  if (d.startsWith("1") && d.length === 11) return "Amerika Serikat";
  return null;
}

async function stockCounts(q) {
  const rows = await q`SELECT country, count(*)::int AS n FROM number_stock WHERE order_id IS NULL GROUP BY country`;
  const by = new Map(rows.map((r) => [r.country ?? null, Number(r.n)]));
  return { by, total: rows.reduce((a, r) => a + Number(r.n), 0) };
}

const stockLine = (by) =>
  Object.keys(COUNTRIES).map((n) => `${FLAG[n]} ${by.get(n) ?? 0}`).join(" · ") + (by.get(null) ? ` · ❔ ${by.get(null)}` : "");

async function stockView(q) {
  const { by, total } = await stockCounts(q);
  const [u] = await q`SELECT count(*)::int AS n FROM number_stock WHERE order_id IS NOT NULL`;
  return [
    "📦 <b>Stok nomor</b>",
    ...Object.keys(COUNTRIES).map((n) => `${FLAG[n]} ${esc(n)}: <b>${by.get(n) ?? 0}</b>`),
    by.get(null) ? `❔ Prefix tidak dikenal: <b>${by.get(null)}</b>` : null,
    `Tersedia: <b>${total}</b> · sudah terpakai: ${u.n}`,
    "",
    "<i>Tambah: /stock · Hapus: /stock hapus 62856xxxxxxx</i>",
  ].filter((x) => x !== null).join("\n");
}

/** Masukkan banyak nomor sekaligus (satu per baris). */
async function addNumbers(q, text) {
  const lines = String(text).split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean).slice(0, 500);
  const valid = [], bad = [], seen = new Set();
  for (const l of lines) {
    const n = normPhone(l);
    if (!n) bad.push(l);
    else if (!seen.has(n)) { seen.add(n); valid.push(n); }
  }
  const added = [];
  for (let i = 0; i < valid.length; i += 20) {
    const part = valid.slice(i, i + 20);
    const res = await Promise.all(part.map((n) => q`INSERT INTO number_stock (phone, country) VALUES (${n}, ${countryOfPhone(n)})
      ON CONFLICT (phone) DO NOTHING RETURNING id`));
    res.forEach((rows, k) => { if (rows.length) added.push(part[k]); });
  }
  const per = new Map();
  for (const n of added) per.set(countryOfPhone(n), (per.get(countryOfPhone(n)) ?? 0) + 1);
  const { by, total } = await stockCounts(q);
  const out = [];
  out.push(added.length ? `✅ <b>${added.length} nomor</b> masuk stock` : "Tidak ada nomor baru yang masuk.");
  if (added.length) out.push([...per].map(([c, n]) => `${c ? FLAG[c] + " " + c : "❔ Prefix tidak dikenal"}: +${n}`).join("\n"));
  const dup = lines.length - bad.length - added.length;
  if (dup) out.push(`♻️ ${dup} nomor sudah ada (dilewati)`);
  if (bad.length) out.push(`⚠️ ${bad.length} baris tidak valid (harus angka 8–15 digit):\n<code>${bad.slice(0, 5).map(esc).join("\n")}${bad.length > 5 ? "\n…" : ""}</code>`);
  out.push("", `📦 Stok sekarang (${total}): ${stockLine(by)}`);
  return out.join("\n");
}

/** Ambil satu nomor acak yang belum terpakai (atomik; aman kalau dua admin menekan bersamaan). */
async function claimOne(q, orderId, country) {
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = country
      ? await q`UPDATE number_stock SET order_id = ${orderId}, used_at = ${now}
          WHERE order_id IS NULL AND id = (SELECT id FROM number_stock WHERE order_id IS NULL AND country = ${country} ORDER BY random() LIMIT 1)
          RETURNING phone`
      : await q`UPDATE number_stock SET order_id = ${orderId}, used_at = ${now}
          WHERE order_id IS NULL AND id = (SELECT id FROM number_stock WHERE order_id IS NULL AND country IS NULL ORDER BY random() LIMIT 1)
          RETURNING phone`;
    if (rows.length) return rows[0].phone;
    const left = country
      ? await q`SELECT count(*)::int AS n FROM number_stock WHERE order_id IS NULL AND country = ${country}`
      : await q`SELECT count(*)::int AS n FROM number_stock WHERE order_id IS NULL AND country IS NULL`;
    if (!Number(left[0].n)) return null;
  }
  return null;
}

/** Nomor sesuai negara order dulu; kalau habis, pakai nomor yang prefix-nya tidak dikenal. */
async function claimNumbers(q, order, n) {
  const got = [];
  let loose = false;
  for (let i = 0; i < n; i++) {
    let p = await claimOne(q, order.id, order.country);
    if (!p) { p = await claimOne(q, order.id, null); if (p) loose = true; }
    if (!p) break;
    got.push(p);
  }
  return { got, loose };
}

/**
 * /proses: isi Status/Nomor/Otp. Nomor diambil random dari stock (sebanyak jumlah order).
 * Dipanggil ulang tidak mengambil nomor baru, kecuali reroll.
 */
async function processOrder(q, order, { reroll = false, msgText = "" } = {}) {
  const ref = orderRef(order.id);
  const stage = stageOf(order);
  if (isClosedStage(stage)) return { error: `Order #${ref} sudah ${stage === "done" ? "selesai" : stage === "failed" ? "gagal" : "dibatalkan"}. Pakai /buka ${ref} dulu kalau mau diproses lagi.` };

  const oldPhones = splitList(order.phone), oldOtps = splitList(order.otp);
  const need = order.quantity;
  let phones = oldPhones;
  const notes = [];
  if (reroll || oldPhones.length < need) {
    const take = reroll ? need : need - oldPhones.length;
    const { got, loose } = await claimNumbers(q, order, take);
    phones = reroll ? got : oldPhones.concat(got);
    if (got.length < take) notes.push(`⚠️ Stok nomor ${esc(order.country)} kurang: butuh ${take}, dapat ${got.length}. Tambah dengan /stock atau isi manual: /no ${ref} 62856xxxxxxx`);
    if (loose) notes.push("ℹ️ Memakai nomor dari stok yang prefix negaranya tidak dikenal.");
    const left = (await stockCounts(q)).by.get(order.country) ?? 0;
    if (left <= 2) notes.push(`📦 Stok ${esc(order.country)} tinggal ${left}.`);
  }
  const otps = phones.map((p) => {
    const i = oldPhones.indexOf(p);
    return i >= 0 && oldOtps.length === oldPhones.length && otpCode(oldOtps[i]) ? oldOtps[i] : WAIT_OTP;
  });
  const patch = { statusText: STATUS_PROSES, otp: phones.length ? otps.join(", ") : WAIT_OTP, raw: msgText || "[proses]" };
  if (phones.length) patch.phone = phones.join(", ");
  const r = await updateAndSync(q, order.id, patch);
  const block = [`Status: ${STATUS_PROSES}`, `Nomor: ${phones.length ? phones.join(", ") : "-"}`, `Otp: ${WAIT_OTP}`].join("\n");
  return { order: r.order, block, notes };
}

/** Cari order dari argumen, reply kartu, atau (opsional) antrian pending paling lama. */
async function pickOrder(ctx, { oldest = false } = {}) {
  const id = parseRef(ctx.args[0]) ?? parseRef(ctx.msg?.reply_to_message?.text);
  if (id) return { id, order: await getOrder(ctx.q, id) };
  if (oldest) {
    const [o] = await ctx.q`SELECT * FROM orders WHERE status = 'pending' ORDER BY id ASC LIMIT 1`;
    return { id: o?.id ?? null, order: o ?? null, auto: true };
  }
  return { id: null, order: null };
}

/* ---------- Perintah ---------- */

const bareOrderArg = (args) => parseRef(args[0]);
const needOrder = (say) => say("Sertakan kode order, contoh: <code>/order RB-0001</code>");

function quickCommand(buildPatch, doneText) {
  return async ({ q, say, args, rest, msg }) => {
    const id = bareOrderArg(args);
    if (!id) return needOrder(say);
    const tail = rest.slice(rest.indexOf(args[0]) + args[0].length).trim();
    const patch = buildPatch(tail);
    if (patch.error) return say(patch.error);
    const r = await updateAndSync(q, id, { ...patch, raw: msg.text });
    if (!r) return say(`Order #${orderRef(id)} tidak ditemukan.`);
    return say(r.changed ? `${doneText} <b>#${orderRef(id)}</b>\n${fieldsText(r.order)}` : `Tidak ada perubahan pada #${orderRef(id)}.`, { reply_to_message_id: msg.message_id });
  };
}

const COMMANDS = {
  async menu({ q, say }) {
    const [a] = await q`SELECT count(*)::int AS n FROM orders
      WHERE status IN ('pending', 'processing') OR (status = 'done' AND closed_at IS NULL)`;
    return say(`🏠 <b>RipBlast Admin</b>\nOrder aktif: <b>${a.n}</b>`, {
      reply_markup: {
        inline_keyboard: [
          [btn(`📋 Antrian (${a.n})`, "m:q"), btn("📊 Statistik", "m:s")],
          [btn("👥 User baru", "m:u"), btn("⚙️ Pengaturan", "m:g")],
          [btn("🩺 Cek sistem", "m:h"), btn("❓ Bantuan", "m:?")],
        ],
      },
    });
  },
  async proses(ctx) {
    const { q, say, args, msg } = ctx;
    const { id, order, auto } = await pickOrder(ctx, { oldest: true });
    if (!id) return say("Tidak ada order yang menunggu. Atau sebut kodenya: <code>/proses RB-0001</code>");
    if (!order) return say(`Order #${orderRef(id)} tidak ditemukan.`);
    const res = await processOrder(q, order, { reroll: args.includes("ganti"), msgText: msg.text });
    if (res.error) return say(res.error);
    return say([auto ? `<i>Memproses antrian paling lama: #${orderRef(order.id)}</i>\n` : "", esc(res.block), ...(res.notes.length ? ["", ...res.notes] : [])].join("\n").trim());
  },
  async done(ctx) {
    const { q, say, args, rest, msg } = ctx;
    const usage = "Contoh: <code>/done 628564802000 199876</code>";
    if (args.length < 2) return say(usage);
    const tail = rest.slice(args[0].length).trim();
    const code = tail.replace(/\D/g, "");
    if (code.length < 4 || code.length > 8) return say("OTP harus 4–8 digit. " + usage);

    let order = null, num = null;
    if (/^#?rb-/i.test(args[0]) || /^#\d+$/.test(args[0])) {
      order = await getOrder(q, parseRef(args[0]));
      const ph = splitList(order?.phone);
      if (order && ph.length === 1) num = normPhone(ph[0]);
      else if (order) return say(`Order #${orderRef(order.id)} punya ${ph.length} nomor. Pakai: <code>/done &lt;nomor&gt; &lt;otp&gt;</code>`);
    } else {
      num = normPhone(args[0]);
      if (!num) return say("Nomor tidak valid. " + usage);
      const cands = await q`SELECT * FROM orders WHERE phone LIKE ${"%" + num + "%"} AND status NOT IN ('failed', 'cancelled') ORDER BY id DESC LIMIT 5`;
      order = cands.find((o) => splitList(o.phone).some((p) => normPhone(p) === num)) ?? null;
    }
    if (!order || !num) return say(`Nomor <code>${esc(args[0])}</code> tidak ada di order aktif. Pastikan nomornya sama dengan yang diisi lewat /proses atau /no.`);

    const phones = splitList(order.phone);
    const idx = phones.findIndex((p) => normPhone(p) === num);
    const old = splitList(order.otp);
    const list = phones.map((_, i) => (old.length === phones.length ? old[i] : WAIT_OTP));
    list[idx] = fmtOtp(code);
    const joined = list.join(", ");
    const complete = otpsComplete(order.phone, joined);
    await updateAndSync(q, order.id, { otp: joined, ...(complete ? { statusText: "Sukses ✅" } : {}), raw: msg.text });

    const out = ["Status: Sukses ✅", `No: ${phones[idx]}`, `otp: ${fmtOtp(code)}`];
    if (phones.length > 1) out.push("", `ℹ️ #${orderRef(order.id)}: ${list.filter((x) => otpCode(x)).length} dari ${phones.length} nomor sudah ada OTP-nya${complete ? " — order selesai." : "."}`);
    return say(esc(out.join("\n")));
  },
  async stock(ctx) {
    const { q, say, rest, args } = ctx;
    if (!rest) {
      return say(
        `<b>${STOCK_PROMPT}</b>\n62851xxxxx\n62856xxxxx\n4487xxxxx\n7333xxxxxx\n\n<i>Reply pesan ini dengan daftar nomor, satu nomor per baris (enter). Bot mendeteksi otomatis.</i>`,
        { reply_markup: { force_reply: true, selective: true, input_field_placeholder: "62851xxxxxxx" } }
      );
    }
    const first = args[0].toLowerCase();
    if (["lihat", "list", "cek"].includes(first)) return say(await stockView(q));
    if (["hapus", "del"].includes(first)) {
      const nums = [...new Set(args.slice(1).map(normPhone).filter(Boolean))];
      if (!nums.length) return say("Contoh: <code>/stock hapus 62856xxxxxxx</code>");
      let n = 0;
      for (const p of nums) n += (await q`DELETE FROM number_stock WHERE phone = ${p} AND order_id IS NULL RETURNING id`).length;
      return say(`🗑 ${n} nomor dihapus dari stock${n < nums.length ? ` (${nums.length - n} tidak ditemukan atau sudah terpakai)` : ""}.`);
    }
    if (["kosongkan", "clear"].includes(first)) {
      if ((args[1] || "").toLowerCase() !== "ya") return say("Ini menghapus semua nomor yang belum terpakai. Ketik <code>/stock kosongkan ya</code> untuk lanjut.");
      const rows = await q`DELETE FROM number_stock WHERE order_id IS NULL RETURNING id`;
      return say(`🗑 ${rows.length} nomor dihapus dari stock.`);
    }
    return say(await addNumbers(q, rest));
  },
  async help({ say }) {
    return say(HELP);
  },
  async pending({ q, say }) {
    const v = await queueView(q);
    return say(v.text, v.markup ? { reply_markup: v.markup } : {});
  },
  async stats({ q, say }) {
    return say(await statsView(q));
  },
  async health({ q, say }) {
    return say(await healthView(q));
  },
  async settings({ q, say }) {
    const v = await settingsView(q);
    return say(v.text, { reply_markup: v.markup });
  },
  async order(ctx) {
    const id = bareOrderArg(ctx.args);
    if (!id) return needOrder(ctx.say);
    const o = await getOrder(ctx.q, id);
    if (!o) return ctx.say(`Order #${orderRef(id)} tidak ditemukan.`);
    return sendCard(ctx, o);
  },
  async orders({ q, say, args }) {
    const status = ["pending", "processing", "done", "failed", "cancelled"].includes(args[0]) ? args[0] : null;
    const n = Math.min(Math.max(parseInt(args[status ? 1 : 0], 10) || 10, 1), 30);
    const rows = status
      ? await q`SELECT o.*, u.username FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = ${status} ORDER BY o.id DESC LIMIT ${n}`
      : await q`SELECT o.*, u.username FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT ${n}`;
    if (!rows.length) return say("Belum ada order.");
    const keys = rows.slice(0, 12).map((o) => btn(`#${orderRef(o.id)}`, `o:${o.id}:i`));
    return say(`🗂 <b>Order ${status ?? "terbaru"}</b>\n\n` + rows.map((o) => orderLine(o, o.username)).join("\n"), {
      reply_markup: { inline_keyboard: Array.from({ length: Math.ceil(keys.length / 3) }, (_, i) => keys.slice(i * 3, i * 3 + 3)) },
    });
  },
  async users({ q, say, args }) {
    const n = Math.min(Math.max(parseInt(args[0], 10) || 10, 1), 30);
    const rows = await q`SELECT u.username, u.banned, u.created_at,
        (SELECT count(*)::int FROM orders o WHERE o.user_id = u.id) AS n
      FROM users u ORDER BY u.id DESC LIMIT ${n}`;
    if (!rows.length) return say("Belum ada user.");
    return say("👥 <b>User terbaru</b>\n\n" + rows.map((u) => `• <code>${esc(u.username)}</code>${u.banned ? " 🚫" : ""} · ${u.n} order · ${ago(u.created_at)}`).join("\n"));
  },
  async find(ctx) {
    const { q, say, rest } = ctx;
    if (!rest) return say("Contoh: <code>/find rani</code> atau <code>/find RB-0007</code>");
    const id = /^#?(RB-)?\d+$/i.test(rest) ? parseRef(rest) : null;
    if (id) {
      const o = await getOrder(q, id);
      if (!o) return say(`Order #${orderRef(id)} tidak ditemukan.`);
      return sendCard(ctx, o);
    }
    const name = rest.toLowerCase().replace(/^@/, "");
    let v = await userSummary(q, q`SELECT * FROM users WHERE username = ${name} LIMIT 1`);
    if (!v) {
      const like = await q`SELECT username FROM users WHERE username LIKE ${name + "%"} ORDER BY id DESC LIMIT 8`;
      if (!like.length) return say("User tidak ditemukan.");
      if (like.length > 1) return say("Mungkin maksudmu:\n" + like.map((u) => `• <code>${esc(u.username)}</code>`).join("\n"));
      v = await userSummary(q, q`SELECT * FROM users WHERE username = ${like[0].username} LIMIT 1`);
    }
    return say(v.text);
  },
  async ban({ q, say, args }) {
    const name = String(args[0] ?? "").toLowerCase().replace(/^@/, "");
    if (!name) return say("Contoh: <code>/ban rani</code>");
    const [u] = await q`UPDATE users SET banned = true WHERE username = ${name} RETURNING id`;
    if (!u) return say("User tidak ditemukan.");
    await q`DELETE FROM sessions WHERE user_id = ${u.id}`;
    const open = await q`SELECT id FROM orders WHERE user_id = ${u.id} AND status IN ('pending', 'processing')`;
    return say(`🚫 <code>${esc(name)}</code> diblokir dan semua sesinya dikeluarkan.${open.length ? `\nMasih ada ${open.length} order aktif: cek /find ${esc(name)}.` : ""}`);
  },
  async unban({ q, say, args }) {
    const name = String(args[0] ?? "").toLowerCase().replace(/^@/, "");
    const [u] = await q`UPDATE users SET banned = false WHERE username = ${name} RETURNING id`;
    return say(u ? `✅ <code>${esc(name)}</code> dibuka blokirnya.` : "User tidak ditemukan.");
  },
  async resetpw({ q, say, args }) {
    const name = String(args[0] ?? "").toLowerCase().replace(/^@/, "");
    if (!name) return say("Contoh: <code>/resetpw rani</code>");
    const pw = randomPassword(10);
    const [u] = await q`UPDATE users SET password_hash = ${await hashPassword(pw)} WHERE username = ${name} RETURNING id`;
    if (!u) return say("User tidak ditemukan.");
    await q`DELETE FROM sessions WHERE user_id = ${u.id}`;
    return say(`🔑 Password baru untuk <code>${esc(name)}</code>:\n<code>${esc(pw)}</code>\n\nKirim ke user lewat jalur pribadi dan minta dia menggantinya (menu akun → Ubah password). Semua sesi lamanya sudah keluar.`);
  },
  otp: quickCommand((t) => (otpCode(t) ? { otp: t.slice(0, 60) } : { error: "Contoh: <code>/otp RB-0001 123456</code>" }), "🔢 OTP tersimpan:"),
  no: quickCommand((t) => {
    const m = t.match(/\+?\d[\dxX*\s-]{6,18}[\dxX*]/);
    return m ? { phone: m[0].replace(/[\s-]/g, "") } : { error: "Contoh: <code>/no RB-0001 62856xxxxxxx</code>" };
  }, "📱 Nomor tersimpan:"),
  selesai: quickCommand(() => ({ close: true }), "✅ Selesai:"),
  gagal: quickCommand((t) => ({ status: "failed", statusText: `Gagal❌${t ? ` (${t.slice(0, 80)})` : ""}` }), "❌ Gagal:"),
  buka: quickCommand(() => ({ reopen: true }), "🔄 Dibuka lagi:"),
  pesan: quickCommand((t) => (t ? { note: t === "-" ? "" : t.slice(0, 300) } : { error: "Contoh: <code>/pesan RB-0001 Nomor sedang dicarikan</code>" }), "💬 Pesan untuk user:"),

  async price({ q, say }) {
    const s = await allSettings(q);
    return say("💰 <b>Harga per nomor</b>\n" + Object.entries(COUNTRIES).map(([n, c]) => `• ${esc(n)} (${c.code}): <b>${rp(priceOf(s, n))}</b>`).join("\n") + "\n\nUbah: <code>/setprice indo 5000</code>");
  },
  async setprice({ q, say, args }) {
    const val = parseInt(String(args.at(-1) ?? "").replace(/\D/g, ""), 10);
    const country = resolveCountry(args.slice(0, -1).join(" "));
    if (!country || !(val >= 100 && val <= 1_000_000)) return say("Contoh: <code>/setprice indo 5000</code> (negara: indo, my, uk, us; harga 100–1.000.000)");
    await setSetting(q, `price:${country}`, val);
    return say(`💰 Harga ${esc(country)} sekarang <b>${rp(val)}</b> per nomor. Order lama tidak berubah.`);
  },
  async negara({ q, say, args }) {
    const onoff = String(args.at(-1) ?? "").toLowerCase();
    const country = resolveCountry(args.slice(0, -1).join(" "));
    if (!country || !["on", "off"].includes(onoff)) return say("Contoh: <code>/negara us off</code> atau <code>/negara indo on</code>");
    if (onoff === "off") await setSetting(q, `stock:${country}`, "off");
    else await delSetting(q, `stock:${country}`);
    return say(`${onoff === "on" ? "✅" : "⛔"} ${esc(country)} ${onoff === "on" ? "tersedia lagi" : "ditandai habis (tidak bisa diorder)"}.`);
  },
  async maintenance({ q, say, args, rest }) {
    const onoff = (args[0] || "").toLowerCase();
    if (!["on", "off"].includes(onoff)) return say("Contoh: <code>/maintenance on Kembali jam 20.00</code> atau <code>/maintenance off</code>");
    if (onoff === "on") {
      await setSetting(q, "maintenance", "1");
      const msg = rest.slice(2).trim().slice(0, 150);
      if (msg) await setSetting(q, "maintenance_msg", msg);
      else await delSetting(q, "maintenance_msg");
      return say("🛠 Maintenance <b>ON</b>: form order di web ditutup. Order yang sudah masuk tetap bisa kamu proses.");
    }
    await delSetting(q, "maintenance");
    await delSetting(q, "maintenance_msg");
    return say("✅ Maintenance <b>OFF</b>: order dibuka lagi.");
  },
  async chat({ q, say, rest, msg }) {
    const body = String(rest ?? '').trim();
    if (/^\/clear$/i.test(body) || /^clear$/i.test(body)) {
      const rows = await q`DELETE FROM chat_messages RETURNING id`;
      return say(`Chat global dibersihkan. ${rows.length} pesan dihapus.`);
    }
    const text = body.slice(0, 4000);
    if (!text) return say('Contoh: <code>./chat Promo hari ini</code> — baris baru tetap dipertahankan. Gunakan <code>./chat /clear</code> untuk membersihkan riwayat.');
    const [row] = await q`INSERT INTO chat_messages (sender_name, sender_kind, body, telegram_message_id) VALUES ('Admin RipBlast', 'admin', ${text}, ${msg.message_id}) RETURNING id`;
    return say(`Chat global terkirim (#${row.id}).`);
  },
  async clear({ q, say }) {
    const rows = await q`DELETE FROM chat_messages RETURNING id`;
    return say(`Chat global dibersihkan. ${rows.length} pesan dihapus.`);
  },
  async popup({ q, say, rest }) {
    const text = String(rest ?? '').trim();
    if (!text || /^(off|hapus|-)$/i.test(text)) {
      await delSetting(q, 'popup');
      return say('Popup announcement dimatikan.');
    }
    await setSetting(q, 'popup', text.slice(0, 1000));
    return say('Popup announcement aktif dan tampil di halaman chat.');
  },
  async announce({ q, say, rest }) {
    if (!rest) return say("Contoh: <code>/announce Promo Malaysia hari ini</code> atau <code>/announce off</code>");
    if (/^(off|hapus|-)$/i.test(rest)) {
      await delSetting(q, "announce");
      return say("📢 Pengumuman dihapus dari web.");
    }
    await setSetting(q, "announce", rest.slice(0, 200));
    return say(`📢 Pengumuman tampil di web:\n<i>${esc(rest.slice(0, 200))}</i>`);
  },
  async wa({ q, say, args }) {
    const v = String(args[0] ?? "").replace(/[^\d]/g, "");
    if (/^(off|hapus|-)$/i.test(args[0] ?? "")) {
      await delSetting(q, "wa");
      return say("💬 Nomor WhatsApp kontak dihapus (web memakai nomor bawaan).");
    }
    if (v.length < 8 || v.length > 15) return say("Contoh: <code>/wa 6281234567890</code> (format internasional tanpa +)");
    await setSetting(q, "wa", v);
    return say(`💬 Form Contact di web sekarang mengarah ke <code>${v}</code>.`);
  },
  async notif({ q, say, args }) {
    const onoff = String(args.at(-1) ?? "").toLowerCase();
    if (!["on", "off"].includes(onoff)) return say("Contoh: <code>/notif on</code> atau <code>/notif off</code> (notifikasi saat ada user baru daftar)");
    await setSetting(q, "notify_register", onoff === "on" ? "1" : "0");
    return say(`🔔 Notifikasi user baru: <b>${onoff.toUpperCase()}</b>`);
  },
  async export({ q, say, args, chatId }) {
    const days = Math.min(Math.max(parseInt(args[0], 10) || 0, 0), 3650);
    const since = days ? new Date(Date.now() - days * 86400_000).toISOString() : "1970-01-01T00:00:00.000Z";
    const rows = await q`SELECT o.*, u.username FROM orders o JOIN users u ON u.id = o.user_id
                         WHERE o.created_at >= ${since} ORDER BY o.id ASC LIMIT 5000`;
    if (!rows.length) return say("Tidak ada order pada rentang itu.");
    const head = ["kode", "waktu_wib", "user", "negara", "jumlah", "harga", "status", "tahap", "no", "otp", "status_teks", "catatan_user", "pesan_admin"];
    const lines = rows.map((o) =>
      [orderRef(o.id), wib(o.created_at), o.username, o.country, o.quantity, o.price ?? "", o.status, stageOf(o), o.phone ?? "", o.otp ?? "", o.status_text ?? "", o.note ?? "", o.admin_note ?? ""].map(csvCell).join(",")
    );
    const file = "\ufeff" + [head.join(","), ...lines].join("\n");
    const r = await tgDocument(chatId, `ripblast-order-${new Date().toISOString().slice(0, 10)}.csv`, file, `📤 ${rows.length} order${days ? ` (${days} hari terakhir)` : " (semua)"}`);
    if (!r.ok) return say("Gagal mengirim file: " + esc(r.description || "?"));
  },
};
COMMANDS.start = COMMANDS.menu;
COMMANDS.antrian = COMMANDS.pending;
COMMANDS.statistik = COMMANDS.stats;
COMMANDS.setting = COMMANDS.settings;
COMMANDS.pengaturan = COMMANDS.settings;
COMMANDS.stok = COMMANDS.stock;
COMMANDS.harga = COMMANDS.price;
COMMANDS.cari = COMMANDS.find;

/* ---------- Pesan masuk ---------- */

export async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = String(msg.text ?? "").trim();
  const isAdmin = adminIds().includes(chatId);
  const say = (t, extra = {}) => sendHtml(chatId, t, extra);

  const cmd = text.match(/^(?:\/([a-z_]+)|\.\/chat)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (cmd) {
    const name = cmd[1] ? cmd[1].toLowerCase() : 'chat';
    const rest = (cmd[2] || "").trim();
    if ((name === "start" || name === "id") && !isAdmin) {
      return say(`Chat ID kamu: <code>${chatId}</code>\n\nKalau kamu pemilik bot ini, isi <code>TELEGRAM_ADMIN_CHAT_ID</code> dengan angka di atas di Vercel (Settings → Environment Variables), lalu redeploy.`);
    }
    if (name === "id") return say(`Chat ID: <code>${chatId}</code>`);
    if (!isAdmin) return;
    const fn = COMMANDS[name];
    if (!fn) return say("Perintah tidak dikenal. Ketik /help.");
    const q = await db();
    return fn({ q, chatId, say, rest, args: rest ? rest.split(/\s+/) : [], msg });
  }
  if (!isAdmin) return;
  return handleFreeText({ chatId, say, msg, text });
}

/** Alur lama: reply kartu order dengan Status/No/Otp, atau kirim "#RB-0001 Otp: 123456". Ditambah balasan force-reply. */
async function handleFreeText({ say, msg, text }) {
  const q = await db();
  const reply = msg.reply_to_message;

  // Stock nomor: balasan atas prompt /stock, atau daftar nomor (2+ baris) yang dikirim langsung.
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const looksLikeList = !reply && lines.length >= 2 && lines.every((l) => /^\+?[\d\s-]{8,20}$/.test(l));
  if (String(reply?.text ?? "").startsWith(STOCK_PROMPT) || looksLikeList) return say(await addNumbers(q, text));

  let order = null;
  const fromReply = parseRef(reply?.text);
  if (fromReply) order = await getOrder(q, fromReply);
  if (!order && reply?.message_id) [order] = await q`SELECT * FROM orders WHERE tg_message_id = ${reply.message_id} LIMIT 1`;
  if (!order) {
    const own = parseRef(text.match(/#?RB-\d+/i)?.[0]);
    if (own) order = await getOrder(q, own);
  }
  if (!order) {
    return say("Order tidak ditemukan. Reply kartu order, atau sertakan kodenya (contoh <code>#RB-0007 Otp: 123456</code>). Ketik /help untuk semua perintah.");
  }

  let f = parseAdminReply(text);
  const prompt = String(reply?.text ?? "");
  const bare = text.replace(/[\s-]/g, "");
  if (!f.statusText && !f.phone && !f.otp && f.note === null) {
    if (/^📱 Nomor untuk/.test(prompt) && /^\+?\d[\dxX*]{6,}$/.test(bare)) f = { ...f, phone: bare };
    else if (/^🔢 OTP untuk/.test(prompt) && otpCode(text)) f = { ...f, otp: text.slice(0, 60) };
    else if (/^\d{4,8}$/.test(bare) && fromReply) f = { ...f, otp: text.slice(0, 60) };
    else if (/^\+?\d{9,16}$/.test(bare) && fromReply) f = { ...f, phone: bare };
  }
  if (!f.statusText && !f.phone && !f.otp && f.note === null) {
    return say("Format belum terbaca. Contoh:\n<code>Status: Sukses✅ (tunggu 1-2 minute)\nNo: 62856xxxxx\nOtp: 123456</code>\n\nAtau pakai tombol di kartu order.", { reply_to_message_id: msg.message_id });
  }
  const r = await updateAndSync(q, order.id, { statusText: f.statusText ?? undefined, phone: f.phone ?? undefined, otp: f.otp ?? undefined, note: f.note ?? undefined, raw: text });
  return say(
    r.changed
      ? `✅ Order <b>#${orderRef(order.id)}</b> diperbarui, sudah tampil di web user.\n${fieldsText(r.order)}`
      : `Tidak ada perubahan pada #${orderRef(order.id)}.`,
    { reply_to_message_id: msg.message_id }
  );
}

/* ---------- Tombol inline ---------- */

const answer = (cb, text = "", alert = false) => tg("answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: alert });

export async function handleCallback(cb) {
  const chatId = String(cb.message?.chat?.id ?? "");
  if (!adminIds().includes(chatId)) return answer(cb, "Kamu bukan admin bot ini.", true);
  const q = await db();
  const [kind, a, b] = String(cb.data || "").split(":");
  const say = (t, extra = {}) => sendHtml(chatId, t, extra);
  const ctx = { q, chatId, say };

  if (kind === "m") {
    await answer(cb);
    const fn = { q: COMMANDS.pending, s: COMMANDS.stats, u: COMMANDS.users, g: COMMANDS.settings, h: COMMANDS.health, "?": COMMANDS.help }[a];
    return fn?.({ ...ctx, rest: "", args: [], msg: cb.message });
  }

  if (kind === "g" || kind === "k") {
    const s = await allSettings(q);
    let toast = "Tersimpan";
    if (kind === "g" && a === "mt") {
      if (isMaintenance(s)) await delSetting(q, "maintenance");
      else await setSetting(q, "maintenance", "1");
      toast = isMaintenance(s) ? "Order dibuka lagi" : "Maintenance ON";
    } else if (kind === "g" && a === "nr") {
      await setSetting(q, "notify_register", s.notify_register === "1" ? "0" : "1");
    } else if (kind === "k" && COUNTRIES[a]) {
      if (inStock(s, a)) await setSetting(q, `stock:${a}`, "off");
      else await delSetting(q, `stock:${a}`);
      toast = inStock(s, a) ? `${a} ditandai habis` : `${a} tersedia`;
    }
    await answer(cb, toast);
    const v = await settingsView(q);
    const r = await tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: v.text, parse_mode: "HTML", reply_markup: v.markup });
    if (!r.ok && !/not modified/i.test(r.description || "")) await say(v.text, { reply_markup: v.markup });
    return;
  }

  if (kind !== "o") return answer(cb);
  const id = Number(a);
  const order = await getOrder(q, id);
  if (!order) return answer(cb, "Order tidak ditemukan.", true);
  const ref = orderRef(id);

  if (b === "i") {
    await answer(cb);
    return sendCard(ctx, order);
  }
  if (b === "u") {
    const v = await userSummary(q, q`SELECT * FROM users WHERE id = ${order.user_id} LIMIT 1`);
    await answer(cb);
    return say(v ? v.text : "User tidak ditemukan.");
  }
  if (b === "n" || b === "t") {
    await answer(cb);
    const isNo = b === "n";
    return say(`${isNo ? "📱 Nomor untuk" : "🔢 OTP untuk"} <b>#${ref}</b>\nReply pesan ini dengan ${isNo ? "nomornya" : "kodenya"}.`, {
      reply_markup: { force_reply: true, selective: true, input_field_placeholder: isNo ? "62856xxxxxxx" : "123456" },
    });
  }

  if (b === "p") {
    const res = await processOrder(q, order, { msgText: "[tombol proses]" });
    if (res.error) return answer(cb, res.error.slice(0, 190), true);
    await answer(cb, `#${ref} diproses`);
    return say([esc(res.block), ...(res.notes.length ? ["", ...res.notes] : [])].join("\n"));
  }

  const patch = {
    d: { close: true },
    f: { status: "failed", statusText: "Gagal❌" },
    r: { reopen: true },
  }[b];
  if (!patch) return answer(cb);
  const r = await updateAndSync(q, id, { ...patch, raw: `[tombol ${b}]` });
  return answer(cb, r?.changed ? { d: `#${ref} selesai`, f: `#${ref} ditandai gagal`, r: `#${ref} dibuka lagi` }[b] : "Tidak ada perubahan");
}
