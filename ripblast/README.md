# RipBlast v3 (Vercel)

Order nomor kosong dengan login/register, kartu order + tombol di bot Telegram admin, dan status/nomor/OTP yang tampil live di web.
Static site + Vercel Functions (`/api`) + Postgres (Neon). **Tidak ada environment variable baru**: pakai yang sudah ada.

## Upgrade dari versi sebelumnya
1. Timpa isi repo dengan folder ini, commit, push (Vercel deploy otomatis).
2. Buka sekali: `https://DOMAINMU/api/telegram/setup?key=NILAI_TELEGRAM_WEBHOOK_SECRET`
   (mendaftarkan tombol inline dan daftar perintah bot yang baru).
3. Kirim `/menu` ke bot. Selesai. Tabel baru dan kolom baru dibuat otomatis, data lama tetap aman.

Env tetap: `DATABASE_URL` (atau `POSTGRES_URL`/varian berprefix), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, opsional `SITE_URL`.

## Alur kerja admin di bot
1. **Isi stock**: kirim `/stock`, lalu reply pesan bot dengan nomor-nomor, satu per baris (enter). Atau langsung tempel daftar 2+ baris, bot mendeteksi otomatis.
   Format fleksibel: `62851xxxxxxx`, `0856-1234-5678`, `+60 12-345 6789`. Duplikat dan baris tidak valid dilaporkan.
2. **Order masuk** → kartu order muncul di bot (dengan tombol).
3. **`/proses`** (atau tombol ⏳ Proses, atau `/proses RB-0001`): nomor dipilih **random** dari stock sesuai negara order (sebanyak jumlah order), lalu bot membalas:
   ```
   Status: proses (tunggu 1-2 menitan)🕘
   Nomor: 62851xxxxx
   Otp: Menunggu admin🔄
   ```
   `/proses` tanpa kode = order antrian paling lama. `/proses RB-0001 ganti` = ambil nomor baru.
4. **`/done 628564802000 199876`** → bot membalas
   ```
   Status: Sukses ✅
   No: 628564802000
   otp: 199-876
   ```
   Order di web otomatis jadi Selesai dan OTP tampil. Order berisi banyak nomor: tiap nomor punya OTP sendiri, order selesai setelah semuanya terisi.

Alur lama tetap jalan: reply kartu order dengan `Status: ... / No: ... / Otp: ... / Pesan: ...`.

## Semua perintah admin
| Kelompok | Perintah |
|---|---|
| Order | `/pending` `/order RB-0001` `/orders [status] [n]` `/proses` `/done` `/otp` `/no` `/selesai` `/gagal [alasan]` `/buka` `/pesan RB-0001 teks` |
| Stock | `/stock` `/stock lihat` `/stock hapus <nomor>` `/stock kosongkan ya` |
| User | `/find nama|RB-0001` `/users` `/ban` `/unban` `/resetpw nama` |
| Toko | `/settings` (panel tombol) `/price` `/setprice indo 5000` `/negara us off` `/maintenance on pesan` `/announce teks` `/wa 628xxx` `/notif on|off` |
| Laporan | `/stats` `/export [hari]` (CSV) `/health` `/menu` `/help` |

Nama negara boleh disingkat: `indo`, `my`, `uk`, `us`.
Tombol di kartu order: Proses, Isi nomor, Isi OTP, Selesai, Gagal, Info user, Buka lagi. Kartu ikut ter-update di semua chat admin.

## Yang baru di web
Pilih negara lewat kartu (harga & stok live), stepper jumlah + ringkasan total, dashboard (statistik, filter, progres 4 tahap, riwayat, salin nomor/OTP, batalkan order pending, order lagi), notifikasi saat OTP masuk (getar, judul tab, notifikasi browser opsional), menu akun + ubah password, banner pengumuman, mode maintenance, FAQ.

## Keamanan & backend
- Rate limit login/daftar/order/ubah password (disimpan di database, aman lintas instance serverless).
- Cek Origin untuk request tulis, header keamanan + CSP (`vercel.json`), login tidak membocorkan ada/tidaknya username, akun bisa diblokir.
- Harga disimpan per order (perubahan harga tidak mengubah order lama). Statistik di web hanya tampil kalau datanya cukup.
- Pengaturan toko (harga, stok negara, maintenance, pengumuman, WhatsApp) disimpan di tabel `settings`.

## Catatan
- Nomor WhatsApp form Contact: atur lewat bot `/wa 628xxxxxxxxxx` (bawaan di `app.js` masih contoh).
- Kalau webhook tidak masuk, matikan Deployment Protection untuk production di Vercel. Cek `/api/health` atau `/health` di bot.
- Lokal: `npm i -g vercel`, `vercel link`, `vercel env pull`, `npm run dev`.
