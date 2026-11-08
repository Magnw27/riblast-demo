const $ = s => document.querySelector(s);
let toastT;
const toast = m => { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3200); };

/* Tujuan setelah berhasil: hanya path internal, bukan URL luar */
const raw = new URLSearchParams(location.search).get("next") || "/#order";
const NEXT = raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\") ? raw : "/#order";

const swap = $("#swapLink");
if (swap) swap.href = swap.getAttribute("href") + "?next=" + encodeURIComponent(NEXT);

/* Kalau sudah login, tidak perlu di sini */
fetch("/api/auth/me").then(r => r.json()).then(d => { if (d.user) location.replace(NEXT); }).catch(() => {});

const form = $("#authForm"), mode = form.dataset.mode;
const btn = $("#authGo"), lbl = btn.querySelector(".lbl"), err = $("#formErr"), card = $("#authCard");
const idle = lbl.textContent;

function fail(msg) {
  err.textContent = msg; err.hidden = false;
  card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake");
  toast(msg);
}

/* Lihat/sembunyikan password */
$("#pwToggle").addEventListener("click", e => {
  const i = $("#ap"), show = i.type === "password";
  i.type = show ? "text" : "password";
  e.currentTarget.textContent = show ? "Sembunyi" : "Lihat";
  e.currentTarget.setAttribute("aria-label", show ? "Sembunyikan password" : "Tampilkan password");
});

/* Indikator kekuatan password (hanya saran, bukan syarat) */
if (mode === "register") {
  $("#ap").addEventListener("input", () => {
    const p = $("#ap").value;
    let sc = 0;
    if (p.length >= 6) sc++; if (p.length >= 10) sc++;
    if (/[a-z]/.test(p) && /[A-Z]/.test(p)) sc++;
    if (/\d/.test(p) && /[^a-zA-Z0-9]/.test(p)) sc++;
    if (!p) sc = -1;
    const L = [["20%", "#ff5b4f", "Lemah, coba lebih panjang"], ["45%", "#ffc46b", "Cukup"], ["75%", "#7b8cff", "Bagus"], ["100%", "#4fe3c1", "Kuat"]];
    const k = Math.min(Math.max(sc - 1, 0), 3);
    $("#meterBar").style.width = sc < 0 ? "0" : L[k][0];
    $("#meterBar").style.background = L[k][1];
    $("#meterTxt").textContent = sc < 0 ? "" : p.length < 6 ? "Minimal 6 karakter" : L[k][2];
  });
}

form.addEventListener("submit", async e => {
  e.preventDefault();
  err.hidden = true;
  const username = $("#au").value.trim().toLowerCase(), password = $("#ap").value;
  if (!/^[a-z0-9_.]{3,24}$/.test(username)) return fail("Username 3-24 karakter: huruf kecil, angka, titik, atau underscore.");
  if (password.length < 6) return fail("Password minimal 6 karakter.");
  if (mode === "register" && password !== $("#ap2").value) return fail("Ulangi password tidak sama.");

  btn.disabled = true;
  lbl.textContent = mode === "login" ? "Memeriksa..." : "Membuat akun...";
  try {
    const r = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Gagal, coba lagi.");
    toast(mode === "login" ? `Halo ${d.user.username}!` : `Akun dibuat. Selamat datang, ${d.user.username}!`);
    setTimeout(() => location.assign(NEXT), 500);
  } catch (ex) {
    fail(ex.message || "Koneksi bermasalah, coba lagi.");
    btn.disabled = false; lbl.textContent = idle;
  }
});
