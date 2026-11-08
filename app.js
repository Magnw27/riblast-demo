const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const rm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const mobile = matchMedia("(max-width: 640px), (pointer: coarse)").matches;
const rp = n => "Rp " + String(Math.round(+n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const fmtDate = iso => new Date(iso).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (n, a, b) => Math.min(Math.max(n, a), b);
function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 45) return "baru saja";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} jam lalu`;
  return `${Math.round(h / 24)} hari lalu`;
}
let toastT;
function toast(m, good) {
  const t = $("#toast");
  t.textContent = m; t.classList.toggle("good", !!good); t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3400);
}
async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: "same-origin", ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  let d = {}; try { d = await r.json(); } catch { /* respons bukan JSON */ }
  return { r, d };
}

const ADMIN_WA_FALLBACK = "6281234567890"; // nomor bawaan; admin bisa menggantinya lewat bot: /wa 628xxxxxxxxxx
const NEXT_ORDER = "%2Forder%23order";
const DEFAULT_CFG = {
  countries: [
    { name: "Indonesia", code: "+62", price: 4500, available: true },
    { name: "Malaysia", code: "+60", price: 5000, available: true },
    { name: "Inggris", code: "+44", price: 6500, available: true },
    { name: "Amerika Serikat", code: "+1", price: 6000, available: true }
  ],
  maintenance: { on: false, message: "" }, announcement: "", wa: "", stats: null
};
let CFG = DEFAULT_CFG, ME = null;

/* ===== Kanvas blast ===== */
(function () {
  const c = $("#blast"), x = c.getContext("2d");
  let W, H, D, run = false, ps = [], last = 0, lastFrame = 0, glow = null;
  const MAXP = mobile ? 22 : 36, FRAME = mobile ? 1000 / 40 : 0;
  const size = () => { D = Math.min(devicePixelRatio || 1, mobile ? 1.25 : 1.5); const r = c.getBoundingClientRect(); W = r.width; H = r.height; c.width = Math.round(W * D); c.height = Math.round(H * D); x.setTransform(D, 0, 0, D, 0, 0); glow = null; };
  const rr = (a, b, w, h) => { x.beginPath(); x.roundRect ? x.roundRect(a, b, w, h, 4) : x.rect(a, b, w, h); x.fill(); };
  let dt = 1;
  function draw(now) {
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 6;
    x.clearRect(0, 0, W, H);
    for (let k = 0; k < 3; k++) {
      const p = (now / 2600 + k / 3) % 1;
      x.strokeStyle = `rgba(123,140,255,${(1 - p) * .35})`; x.lineWidth = 1.5;
      x.beginPath(); x.arc(cx, cy, 34 + p * (R - 34), 0, 6.283); x.stroke();
    }
    for (const p of ps) {
      const px = cx + Math.cos(p.a) * p.d, py = cy + Math.sin(p.a) * p.d, f = p.d / R;
      x.globalAlpha = Math.min(1, (1 - f) * 2.2);
      x.fillStyle = p.ok ? "#4fe3c1" : "#ff5b4f";
      rr(px - 9, py - 6, 18, 12);
      if (f > .6) { x.strokeStyle = "#0a0c16"; x.lineWidth = 1.6; x.beginPath(); x.moveTo(px - 3, py); x.lineTo(px - 1, py + 2.5); x.lineTo(px + 3.5, py - 2.5); x.stroke(); }
      if (!rm) p.d += p.sp * R / 150 * dt;
    }
    x.globalAlpha = 1;
    if (!glow) { glow = x.createRadialGradient(cx, cy, 8, cx, cy, 58); glow.addColorStop(0, "rgba(255,91,79,.55)"); glow.addColorStop(1, "rgba(255,91,79,0)"); }
    x.fillStyle = glow; x.fillRect(cx - 60, cy - 60, 120, 120);
    x.fillStyle = "#ff5b4f"; x.beginPath(); x.arc(cx, cy, 30, 0, 6.283); x.fill();
    x.fillStyle = "#1d0805"; x.font = "800 15px 'Bricolage Grotesque',sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText("RB", cx, cy + 1);
    ps = ps.filter(p => p.d < R);
  }
  function loop(now) {
    if (!run) return;
    requestAnimationFrame(loop);
    if (FRAME && now - lastFrame < FRAME - 2) return;
    dt = lastFrame ? Math.min((now - lastFrame) / 16.67, 3) : 1; lastFrame = now;
    if (now - last > 240 && ps.length < MAXP) { last = now; ps.push({ a: Math.random() * 6.283, d: 36, sp: .6 + Math.random() * .8, ok: Math.random() < .94 }); }
    draw(now);
  }
  const set = v => { if (v && !rm && !run) { run = true; lastFrame = 0; requestAnimationFrame(loop); } else if (!v) run = false; };
  let vis = true;
  new IntersectionObserver(e => { vis = e[0].isIntersecting; set(vis && !document.hidden); }).observe(c);
  document.addEventListener("visibilitychange", () => set(vis && !document.hidden));
  let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { size(); if (rm) draw(0); }, 150); }, { passive: true });
  size(); if (rm) { for (let i = 0; i < 14; i++) ps.push({ a: i * .45, d: 50 + i * 9, sp: 0, ok: true }); draw(0); }
})();

/* ===== Menu aktif & reveal ===== */
(function () {
  const links = $$(".links a, .tabbar a");
  $$("main section").forEach(s => new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    links.forEach(a => a.classList.toggle("on", a.getAttribute("href") === "#" + s.id));
  }), { rootMargin: "-45% 0px -50% 0px" }).observe(s));
})();
const io = new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting) { e.target.classList.add("vis"); io.unobserve(e.target); }
}), { threshold: .12 });
$$(".reveal").forEach(el => io.observe(el));

/* ===== Konfigurasi publik (harga, stok, pengumuman) ===== */
let selCountry = "Indonesia";
const priceOf = name => (CFG.countries.find(c => c.name === name) || {}).price || 5000;

async function loadConfig() {
  try {
    const { r, d } = await api("/api/config");
    if (r.ok && Array.isArray(d.countries)) CFG = d;
  } catch { /* pakai konfigurasi terakhir */ }
  applyConfig();
}

function applyConfig() {
  const first = CFG.countries.find(c => c.available);
  const cur = CFG.countries.find(c => c.name === selCountry);
  if (!cur || !cur.available) selCountry = first ? first.name : (CFG.countries[0] || {}).name;

  $("#cList").innerHTML = `<legend>Negara</legend>` + CFG.countries.map(c => `
    <label class="cc"><input type="radio" name="country" value="${esc(c.name)}" ${c.name === selCountry ? "checked" : ""} ${c.available ? "" : "disabled"}>
      <span class="cc-in"><b>${esc(c.code)}</b><i>${esc(c.name)}</i><em>${c.available ? rp(c.price) : "Stok habis"}</em></span></label>`).join("");

  const items = CFG.countries.map(c => `<span class="${c.available ? "" : "out"}"><b>${esc(c.name)}</b> ${esc(c.code)} · ${c.available ? rp(c.price) : "habis"}</span><i></i>`).join("");
  $("#tickerTrack").innerHTML = items + items;

  const st = CFG.stats, codes = CFG.countries.map(c => c.code).join(" ");
  $("#chip1").innerHTML = st ? `<b>${st.successRate}%</b> order sukses` : `<b>Live</b> status order`;
  $("#chip2").innerHTML = st && st.avgReplyMin ? `<b>~${st.avgReplyMin} mnt</b> respon admin` : `<b>Otomatis</b> OTP masuk`;
  $("#chip3").innerHTML = `<b>${esc(codes)}</b> siap order`;

  const m = CFG.maintenance || {}, dot = $("#pillDot");
  dot.className = "dot" + (m.on ? " off" : !first ? " warn" : "");
  $("#pillText").textContent = m.on ? "Order ditutup sementara" : first ? "Server aktif, stok nomor tersedia" : "Stok nomor sedang habis";
  $("#oClosed").hidden = !m.on;
  $("#oClosedMsg").textContent = m.message || "Coba lagi sebentar lagi.";

  const ann = $("#announce"), text = CFG.announcement || "";
  const closed = (() => { try { return sessionStorage.getItem("rb_ann") === text; } catch { return false; } })();
  $("#announceText").textContent = text;
  ann.hidden = !text || closed;
  updSummary();
}
$("#announceClose").addEventListener("click", () => {
  $("#announce").hidden = true;
  try { sessionStorage.setItem("rb_ann", CFG.announcement || ""); } catch { /* abaikan */ }
});

/* ===== Form order ===== */
const oq = $("#oq"), on = $("#on");
const qtyNow = () => clamp(Math.floor(+oq.value) || 1, 1, 10);
function bump(el) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
function updSummary() {
  const q = qtyNow(), p = priceOf(selCountry);
  $("#sumPrice").textContent = rp(p);
  $("#sumQty").textContent = `${q} nomor`;
  const t = $("#sumTotal"), val = rp(p * q);
  if (t.textContent !== val) { t.textContent = val; bump(t); }
  $$("#qChips button").forEach(b => b.classList.toggle("on", +b.dataset.q === q));
  const m = (CFG.maintenance || {}).on, ok = (CFG.countries.find(c => c.name === selCountry) || {}).available;
  $("#oSend").disabled = !!m || !ok;
}
$("#cList").addEventListener("change", e => { if (e.target.name === "country") { selCountry = e.target.value; updSummary(); } });
$("#qMinus").addEventListener("click", () => { oq.value = clamp(qtyNow() - 1, 1, 10); updSummary(); });
$("#qPlus").addEventListener("click", () => { oq.value = clamp(qtyNow() + 1, 1, 10); updSummary(); });
$("#qChips").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { oq.value = b.dataset.q; updSummary(); } });
oq.addEventListener("input", updSummary);
oq.addEventListener("blur", () => { oq.value = qtyNow(); updSummary(); });
on.addEventListener("input", () => { $("#onCount").textContent = on.value.length; });

/* Draft order disimpan sementara supaya tidak hilang saat diarahkan ke halaman daftar */
const DRAFT = "rb_order_draft";
function saveDraft() { try { sessionStorage.setItem(DRAFT, JSON.stringify({ c: selCountry, q: qtyNow(), n: on.value })); } catch { /* abaikan */ } }
function restoreDraft() {
  try {
    const d = JSON.parse(sessionStorage.getItem(DRAFT) || "null");
    if (!d) return false;
    sessionStorage.removeItem(DRAFT);
    selCountry = d.c; oq.value = d.q; on.value = d.n || ""; $("#onCount").textContent = on.value.length;
    applyConfig();
    return true;
  } catch { return false; }
}

$("#of").addEventListener("submit", async e => {
  e.preventDefault();
  const q = Math.floor(+oq.value);
  if (!(q >= 1 && q <= 10)) { toast("Jumlah nomor harus 1 sampai 10."); oq.focus(); return; }
  if (!ME) {
    saveDraft();
    toast("Daftar dulu ya, ordermu disimpan sementara.");
    setTimeout(() => { location.href = "/register?next=" + NEXT_ORDER; }, 700);
    return;
  }
  const btn = $("#oSend"), lbl = btn.querySelector(".lbl");
  lbl.textContent = "Mengirim...";
  btn.disabled = true; btn.classList.add("busy");
  try {
    const { r, d } = await api("/api/orders", { method: "POST", body: JSON.stringify({ country: selCountry, quantity: q, note: on.value }) });
    if (r.status === 401) { ME = null; updateUI(); saveDraft(); location.href = "/login?next=" + NEXT_ORDER; return; }
    if (!r.ok) {
      if (r.status === 409 || r.status === 503) loadConfig();
      throw new Error(d.error || "Gagal mengirim order.");
    }
    toast(d.notified ? `Order #${d.ref} terkirim ke admin!` : `Order #${d.ref} tersimpan, tapi notifikasi ke admin gagal. Hubungi admin lewat WhatsApp.`, d.notified);
    on.value = ""; $("#onCount").textContent = "0";
    await loadOrders({ force: true });
    $("#oList").firstElementChild?.scrollIntoView({ block: "nearest", behavior: rm ? "auto" : "smooth" });
  } catch (err) {
    toast(err.message || "Koneksi bermasalah, coba lagi.");
  } finally {
    btn.classList.remove("busy");
    lbl.textContent = "Kirim order";
    updSummary();
  }
});

/* ===== Konfirmasi (dialog) ===== */
function ask(title, text, ok = "Ya", no = "Tidak") {
  const d = $("#dlgConfirm");
  if (!d.showModal) return Promise.resolve(confirm(text));
  $("#cfTitle").textContent = title; $("#cfText").textContent = text;
  $("#cfOk").textContent = ok; $("#cfNo").textContent = no;
  d.returnValue = "";
  d.showModal();
  return new Promise(res => d.addEventListener("close", () => res(d.returnValue === "yes"), { once: true }));
}

/* ===== Akun, menu, notifikasi ===== */
const menu = $("#acctMenu"), authBtn = $("#authBtn");
const NOTIF_KEY = "rb_notif";
const notifOn = () => { try { return localStorage.getItem(NOTIF_KEY) === "1" && "Notification" in window && Notification.permission === "granted"; } catch { return false; } };
function closeMenu() { menu.hidden = true; authBtn.setAttribute("aria-expanded", "false"); }
authBtn.addEventListener("click", e => {
  e.stopPropagation();
  if (!ME) { location.href = "/login?next=" + NEXT_ORDER; return; }
  const open = menu.hidden;
  menu.hidden = !open; authBtn.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", e => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenu(); });
$("#mDash").addEventListener("click", () => { closeMenu(); if (document.body.dataset.page !== "order") { location.href = "order.html#order"; return; } $("#order").scrollIntoView({ behavior: rm ? "auto" : "smooth" }); });
$("#mOut").addEventListener("click", () => { closeMenu(); logout(); });
$("#mPass").addEventListener("click", () => {
  closeMenu();
  $("#pf").reset(); $("#pErr").hidden = true;
  const d = $("#dlgPass"); d.showModal ? d.showModal() : toast("Browser ini belum mendukung dialog.");
});
$("#pCancel").addEventListener("click", () => $("#dlgPass").close());
$("#pf").addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("#pErr"), cur = $("#pCur").value, nw = $("#pNew").value;
  const bad = m => { err.textContent = m; err.hidden = false; };
  err.hidden = true;
  if (!cur) return bad("Isi password lama.");
  if (nw.length < 6) return bad("Password baru minimal 6 karakter.");
  if (nw !== $("#pNew2").value) return bad("Ulangi password baru tidak sama.");
  const btn = $("#pGo"); btn.disabled = true;
  try {
    const { r, d } = await api("/api/auth/password", { method: "POST", body: JSON.stringify({ current: cur, next: nw }) });
    if (!r.ok) return bad(d.error || "Gagal mengubah password.");
    $("#dlgPass").close();
    toast("Password diubah. Perangkat lain sudah dikeluarkan.", true);
  } catch { bad("Koneksi bermasalah, coba lagi."); }
  finally { btn.disabled = false; }
});

async function toggleNotif() {
  if (!("Notification" in window)) { toast("Browser ini belum mendukung notifikasi. OTP tetap muncul di halaman."); return; }
  if (notifOn()) { try { localStorage.setItem(NOTIF_KEY, "0"); } catch { /* abaikan */ } paintNotif(); toast("Notifikasi OTP dimatikan."); return; }
  let perm = Notification.permission;
  if (perm === "default") perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("Izin notifikasi ditolak di browser. Aktifkan lewat pengaturan situs."); paintNotif(); return; }
  try { localStorage.setItem(NOTIF_KEY, "1"); } catch { /* abaikan */ }
  paintNotif(); toast("Notifikasi OTP aktif saat tab di latar belakang.", true);
}
function paintNotif() {
  const on_ = notifOn();
  $("#bell").setAttribute("aria-pressed", String(on_));
  $("#mNotifState").textContent = on_ ? "aktif" : "mati";
}
$("#bell").addEventListener("click", toggleNotif);
$("#mNotif").addEventListener("click", () => { closeMenu(); toggleNotif(); });

async function logout() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* tetap keluar di sisi tampilan */ }
  ME = null; stopPoll(); resetOrders(); updateUI();
  toast("Sudah keluar. Sampai jumpa!");
}

function updateUI() {
  $("#oGuest").hidden = !!ME;
  $("#dash").hidden = !ME;
  $("#liveTag").hidden = !ME;
  $("#bell").hidden = !ME || !("Notification" in window);
  if (ME) {
    authBtn.innerHTML = `<span class="av">${esc(ME.username[0])}</span><span class="uname">${esc(ME.username)}</span><svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    authBtn.classList.add("user");
    $("#mUser").textContent = "@" + ME.username;
    paintNotif();
    loadOrders({ force: true });
    startPoll();
  } else {
    authBtn.textContent = "Masuk";
    authBtn.classList.remove("user");
    closeMenu();
  }
}

/* ===== Order: data, polling, render ===== */
const STAGE = {
  pending: ["Menunggu admin", "t-pending"], processing: ["Diproses", "t-processing"], ready: ["Nomor siap", "t-ready"],
  done: ["Selesai", "t-done"], failed: ["Gagal", "t-failed"], cancelled: ["Dibatalkan", "t-cancelled"]
};
const EV = { created: "Order terkirim", processing: "Diproses admin", number: "Nomor dikirim", otp: "OTP masuk", done: "Selesai", failed: "Gagal", cancelled: "Dibatalkan", reopened: "Dibuka lagi", note: "Pesan dari admin" };
const oList = $("#oList"), oEmpty = $("#oEmpty"), oSkel = $("#oSkel"), oMore = $("#oMore");
let orders = [], rev = "", hasMore = false, filter = "all", loaded = false, pollT = null, failCount = 0, busy = false;
const seenCode = new Map(), seenStage = new Map();
const isActive = o => ["pending", "processing", "ready"].includes(o.stage);

function resetOrders() { orders = []; rev = ""; hasMore = false; loaded = false; seenCode.clear(); seenStage.clear(); oList.innerHTML = ""; oEmpty.hidden = true; oSkel.hidden = false; }

function startPoll() { stopPoll(); schedule(); }
function stopPoll() { clearTimeout(pollT); pollT = null; }
function schedule() {
  clearTimeout(pollT);
  const base = orders.some(isActive) ? 4000 : 20000;
  pollT = setTimeout(async () => { if (ME && !document.hidden) await loadOrders(); if (ME) schedule(); }, Math.min(base * 2 ** Math.min(failCount, 3), 30000));
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && ME) { loadOrders(); loadConfig(); schedule(); resetTitle(); } });

function setLive(ok) {
  const t = $("#liveTag"); t.classList.toggle("off", !ok);
  $("#liveTxt").textContent = ok ? "live" : "offline";
}

async function loadOrders({ more = false, force = false } = {}) {
  if (busy && !more) return;
  busy = true;
  try {
    const qs = more ? `?before=${orders.length ? orders[orders.length - 1].id : 0}` : (!force && rev ? `?rev=${encodeURIComponent(rev)}` : "");
    const { r, d } = await api("/api/orders" + qs);
    if (r.status === 401) { ME = null; stopPoll(); resetOrders(); updateUI(); return; }
    if (!r.ok) throw new Error(d.error || "gagal");
    failCount = 0; setLive(true);
    if (d.summary) { $("#tTotal").textContent = d.summary.total; $("#tActive").textContent = d.summary.active; $("#tDone").textContent = d.summary.done; }
    if (d.unchanged) return;
    if (more) {
      const have = new Set(orders.map(o => o.id));
      orders = orders.concat(d.orders.filter(o => !have.has(o.id)));
      hasMore = d.hasMore;
    } else {
      const minId = d.orders.length ? d.orders[d.orders.length - 1].id : Infinity;
      const older = orders.filter(o => o.id < minId);
      orders = d.orders.concat(older);
      hasMore = older.length ? true : d.hasMore;
      rev = d.rev;
    }
    detectChanges();
    renderOrders();
  } catch {
    failCount++; setLive(false);
  } finally { busy = false; }
}
oMore.addEventListener("click", async () => { oMore.disabled = true; await loadOrders({ more: true }); oMore.disabled = false; });

/* Deteksi OTP/nomor yang baru masuk */
let titleT = null;
const baseTitle = document.title;
function resetTitle() { clearInterval(titleT); titleT = null; document.title = baseTitle; }
function notifyOtp(o, shown) {
  toast(`OTP masuk untuk #${o.ref}: ${shown}`, true);
  try { navigator.vibrate && navigator.vibrate([120, 60, 120]); } catch { /* abaikan */ }
  if (document.hidden) {
    if (!titleT) { let on_ = false; titleT = setInterval(() => { document.title = (on_ = !on_) ? `🔔 OTP masuk · ${o.ref}` : baseTitle; }, 1000); }
    if (notifOn()) { try { new Notification(`OTP masuk · ${o.ref}`, { body: `Kode: ${shown}`, tag: o.ref }); } catch { /* abaikan */ } }
  }
}
function detectChanges() {
  const first = !loaded;
  for (const o of orders) {
    const pc = seenCode.get(o.id), ps = seenStage.get(o.id), cs = codeSig(o);
    if (!first) {
      if (o.otpCode && pc !== cs) notifyOtp(o, o.items.map(i => i.otpDisplay).filter(Boolean).join(", ") || o.otpCode);
      else if (ps && ps !== o.stage) {
        if (o.stage === "ready") toast(`Nomor untuk #${o.ref} sudah siap.`, true);
        else if (o.stage === "failed") toast(`Order #${o.ref} gagal. Cek pesan dari admin.`);
        else if (o.stage === "processing") toast(`Order #${o.ref} sedang diproses admin.`);
      }
    }
    seenCode.set(o.id, cs); seenStage.set(o.id, o.stage);
  }
  loaded = true;
}

/* Filter */
$$(".seg button").forEach(b => b.addEventListener("click", () => {
  filter = b.dataset.f;
  $$(".seg button").forEach(x => { const on_ = x === b; x.classList.toggle("on", on_); x.setAttribute("aria-selected", String(on_)); });
  renderOrders();
}));
const passes = o => filter === "all" || (filter === "active" ? isActive(o) : o.stage === "done");

/* Salin */
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch { /* fallback di bawah */ }
  const ta = document.createElement("textarea");
  ta.value = t; ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}
oList.addEventListener("click", async e => {
  const cp = e.target.closest("[data-copy]");
  if (cp) {
    const ok = await copyText(cp.dataset.copy);
    toast(ok ? "Tersalin: " + cp.dataset.copy : "Gagal menyalin, salin manual ya.", ok);
    if (ok) { const old = cp.textContent; cp.textContent = "Tersalin"; cp.classList.add("ok"); setTimeout(() => { cp.textContent = old; cp.classList.remove("ok"); }, 1400); }
    return;
  }
  const cn = e.target.closest("[data-cancel]");
  if (cn) {
    if (!await ask("Batalkan order?", `Order #${cn.dataset.ref} akan dibatalkan dan admin diberi tahu.`, "Ya, batalkan", "Jangan")) return;
    cn.disabled = true;
    const { r, d } = await api("/api/orders", { method: "POST", body: JSON.stringify({ action: "cancel", id: +cn.dataset.cancel }) });
    toast(r.ok ? `Order #${cn.dataset.ref} dibatalkan.` : d.error || "Gagal membatalkan.", r.ok);
    await loadOrders({ force: true });
    return;
  }
  const ag = e.target.closest("[data-again]");
  if (ag) {
    const o = orders.find(x => x.id === +ag.dataset.again);
    if (!o) return;
    const c = CFG.countries.find(x => x.name === o.country);
    if (!c || !c.available) { toast(`Stok ${o.country} sedang habis, pilih negara lain.`); }
    else { selCountry = o.country; }
    oq.value = o.quantity; on.value = o.note || ""; $("#onCount").textContent = on.value.length;
    applyConfig();
    $(".formcard").scrollIntoView({ behavior: rm ? "auto" : "smooth", block: "center" });
    if (c && c.available) toast("Form diisi dari order sebelumnya. Tinggal kirim.", true);
  }
});

/* Render keyed: kartu yang tidak berubah tidak disentuh */
const sig = o => JSON.stringify([o.stage, o.statusText, o.phone, o.otp, o.adminNote, o.price, o.events.length]);
const codeSig = o => o.items.map(i => i.otpCode || "").join("|") + "#" + (o.otpCode || "");
function progress(o) {
  const L = ["Terkirim", "Diproses", "Nomor siap", "OTP"], idx = { pending: 0, processing: 1, ready: 2, done: 3 };
  if (o.stage === "failed" || o.stage === "cancelled") {
    const reached = o.phone ? 2 : o.events.some(e => e.kind === "processing") ? 1 : 0;
    return L.map((t, i) => i <= reached ? `<li class="on">${t}</li>` : i === reached + 1 ? `<li class="bad">${o.stage === "failed" ? "Gagal" : "Batal"}</li>` : `<li>${t}</li>`).join("");
  }
  if (o.stage === "done") return L.map(t => `<li class="on">${t}</li>`).join("");
  const c = idx[o.stage];
  return L.map((t, i) => `<li class="${i < c ? "on" : i === c ? "cur" : ""}">${t}</li>`).join("");
}
function cardHTML(o) {
  const [label, cls] = STAGE[o.stage] || STAGE.pending;
  const price = o.price ?? priceOf(o.country) * o.quantity;
  const rows = [];
  if (o.statusText) rows.push(`<div class="orow2"><small>Status</small><span>${esc(o.statusText)}</span></div>`);
  const waitRow = t => `<div class="orow2"><small>OTP</small><span class="wait">${esc(String(t).replace(/[🔄⏳🕘]/gu, "").trim() || "Menunggu")}</span></div>`;
  const codeRow = it => `<div class="orow2 otp-ready"><small>OTP</small><span class="code">${esc(it.otpDisplay || it.otpCode)}</span><button class="copy" type="button" data-copy="${esc(it.otpCode)}">Salin</button></div>`;
  o.items.forEach((it, i) => {
    rows.push(`<div class="orow2"><small>${o.items.length > 1 ? "No " + (i + 1) : "No"}</small><span class="num">${esc(it.phone)}</span><button class="copy" type="button" data-copy="${esc(it.phone)}">Salin</button></div>`);
    rows.push(it.otpCode ? codeRow(it) : it.otp ? waitRow(it.otp) : "");
  });
  if (!o.items.length && o.otp) rows.push(o.otpCode ? codeRow({ otpCode: o.otpCode }) : waitRow(o.otp));
  const hint = o.stage === "ready" && !o.items.every(i => i.otpCode) ? `<p class="hint">Minta kode OTP di aplikasi tujuan. Kodenya akan muncul di sini otomatis.</p>` : "";
  const acts = o.stage === "pending" ? `<button class="btn ghost danger" type="button" data-cancel="${o.id}" data-ref="${esc(o.ref)}">Batalkan</button>`
    : ["done", "failed", "cancelled"].includes(o.stage) ? `<button class="btn ghost" type="button" data-again="${o.id}">Order lagi</button>` : "";
  const tl = o.events.length ? `<details class="tl"><summary>Riwayat (${o.events.length})</summary><ul>${o.events.map(e => `<li><b>${esc(EV[e.kind] || e.kind)}</b><span>${fmtDate(e.at)}</span></li>`).join("")}</ul></details>` : "";
  return `<div class="orow"><b class="oref">#${esc(o.ref)}</b><span class="tag ${cls}"><i></i>${label}</span></div>
    <div class="ometa">${esc(o.country)} ${esc(o.code)} · ${o.quantity} nomor · ${rp(price)} · <time data-t="${esc(o.createdAt)}">${ago(o.createdAt)}</time></div>
    ${o.note ? `<div class="onote">"${esc(o.note)}"</div>` : ""}
    <ol class="prog" aria-label="Progres order">${progress(o)}</ol>
    ${rows.length ? `<div class="oinfo">${rows.join("")}</div>` : ""}${hint}
    ${o.adminNote ? `<div class="anote"><b>Admin:</b><span>${esc(o.adminNote)}</span></div>` : ""}
    ${acts ? `<div class="oact">${acts}</div>` : ""}${tl}`;
}
let firstPaint = true;
function renderOrders() {
  oSkel.hidden = true;
  const list = orders.filter(passes);
  const old = new Map([...oList.children].map(el => [el.dataset.id, el]));
  let prev = null;
  for (const o of list) {
    const key = String(o.id), s = sig(o);
    let el = old.get(key);
    if (el && el.dataset.sig === s) { old.delete(key); }
    else {
      const n = document.createElement("li");
      n.dataset.id = key; n.dataset.sig = s;
      n.className = `order is-${o.stage}` + (el ? " flash" : firstPaint ? "" : " new");
      n.innerHTML = cardHTML(o);
      if (el) { if (el.querySelector("details[open]")) n.querySelector("details")?.setAttribute("open", ""); el.replaceWith(n); old.delete(key); }
      el = n;
    }
    const at = prev ? prev.nextElementSibling : oList.firstElementChild;
    if (at !== el) oList.insertBefore(el, at);
    prev = el;
  }
  old.forEach(el => el.remove());
  firstPaint = false;
  const empty = !list.length;
  oEmpty.hidden = !empty;
  if (empty) {
    const none = !orders.length;
    $("#oEmptyT").textContent = none ? "Belum ada order" : filter === "active" ? "Tidak ada order aktif" : "Belum ada order selesai";
    $("#oEmptyS").textContent = none ? "Order pertamamu akan muncul di sini lengkap dengan status, nomor, dan OTP dari admin." : "Ganti filter untuk melihat order lainnya.";
  }
  oMore.hidden = !hasMore;
}
setInterval(() => { $$("time[data-t]").forEach(t => { const v = ago(t.dataset.t); if (t.textContent !== v) t.textContent = v; }); }, 30000);

/* ===== Kontak WhatsApp ===== */
$("#cf").addEventListener("submit", e => {
  e.preventDefault();
  const wa = (CFG.wa || ADMIN_WA_FALLBACK).replace(/\D/g, "");
  const t = `Halo RipBlast, saya ${$("#nm").value}. Kebutuhan: ${$("#kb").value}.${ME ? ` Username: ${ME.username}.` : ""} ${$("#ps").value}`;
  const a = document.createElement("a");
  a.href = `https://wa.me/${wa}?text=${encodeURIComponent(t)}`;
  a.target = "_blank"; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  toast("Membuka WhatsApp...");
});

/* ===== Init ===== */
(async () => {
  applyConfig();
  const cfgP = loadConfig();
  try {
    const { d } = await api("/api/auth/me");
    if (d.user) ME = d.user;
  } catch { /* backend belum aktif: tampil sebagai tamu */ }
  updateUI();
  await cfgP;
  if (restoreDraft()) {
    toast(ME ? "Ordermu sudah diisi lagi, tinggal kirim." : "Lanjutkan ordermu setelah login.");
    if (ME) $("#order").scrollIntoView();
  }
  setInterval(loadConfig, 60000);
})();
