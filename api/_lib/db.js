import { neon } from "@neondatabase/serverless";

/** Cari connection string Postgres: DATABASE_URL / POSTGRES_URL, atau varian berprefix (mis. STORAGE_DATABASE_URL). */
export function findDbEnv() {
  const env = process.env;
  const isPg = (v) => typeof v === "string" && /^postgres(ql)?:\/\//i.test(v.trim());
  for (const k of ["DATABASE_URL", "POSTGRES_URL"]) if (isPg(env[k])) return { key: k, url: env[k].trim() };
  const k = Object.keys(env).find(
    (n) => /(DATABASE_URL|POSTGRES_URL)$/.test(n) && !/UNPOOLED|NON_POOLING|NO_SSL|PRISMA/.test(n) && isPg(env[n])
  );
  return k ? { key: k, url: env[k].trim() } : null;
}

let _sql = null;
function client() {
  if (!_sql) {
    const found = findDbEnv();
    if (!found) throw new Error("DATABASE_URL belum terbaca. Cek Environment Variables Vercel lalu redeploy.");
    _sql = neon(found.url);
  }
  return _sql;
}

/** Naikkan angka ini setiap kali skema berubah; migrasi hanya jalan sekali per versi. */
export const SCHEMA_V = "4";

let ready = null;

/**
 * Migrasi aditif: hanya CREATE ... IF NOT EXISTS dan ADD COLUMN IF NOT EXISTS.
 * Data lama (users, orders, sessions) tidak diubah atau dihapus.
 */
async function createSchema() {
  const q = client();
  await q`CREATE TABLE IF NOT EXISTS settings (
    key text PRIMARY KEY,
    value text NOT NULL
  )`;
  const cur = await q`SELECT value FROM settings WHERE key = 'schema_v'`;
  if (cur[0]?.value === SCHEMA_V) return;

  await q`CREATE TABLE IF NOT EXISTS users (
    id serial PRIMARY KEY,
    username text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await q`CREATE TABLE IF NOT EXISTS sessions (
    token text PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await q`CREATE TABLE IF NOT EXISTS orders (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    country text NOT NULL,
    quantity integer NOT NULL DEFAULT 1,
    note text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'pending',
    status_text text,
    phone text,
    otp text,
    admin_message text,
    tg_message_id bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
  // Kolom dari versi lama dan versi baru (aman dijalankan berulang).
  await q`ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_text text`;
  await q`ALTER TABLE orders ADD COLUMN IF NOT EXISTS otp text`;
  await q`ALTER TABLE orders ADD COLUMN IF NOT EXISTS price integer`;
  await q`ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_note text`;
  await q`ALTER TABLE orders ADD COLUMN IF NOT EXISTS closed_at timestamptz`;
  await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS banned boolean NOT NULL DEFAULT false`;
  await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz`;

  await q`CREATE TABLE IF NOT EXISTS order_events (
    id serial PRIMARY KEY,
    order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    kind text NOT NULL,
    detail text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await q`CREATE TABLE IF NOT EXISTS order_msgs (
    order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    chat_id text NOT NULL,
    message_id bigint NOT NULL,
    PRIMARY KEY (order_id, chat_id, message_id)
  )`;
  await q`CREATE TABLE IF NOT EXISTS rate_limits (
    key text PRIMARY KEY,
    n integer NOT NULL,
    reset_at timestamptz NOT NULL
  )`;
  await q`CREATE TABLE IF NOT EXISTS number_stock (
    id serial PRIMARY KEY,
    phone text NOT NULL UNIQUE,
    country text,
    order_id integer REFERENCES orders(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    used_at timestamptz
  )`;
  await q`CREATE INDEX IF NOT EXISTS number_stock_free_idx ON number_stock (country, order_id)`;
  await q`CREATE INDEX IF NOT EXISTS orders_user_idx ON orders (user_id, id DESC)`;
  await q`CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status, id DESC)`;
  await q`CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events (order_id, id)`;

  // Isi data order lama: harga (pakai tarif lama) dan penanda selesai bila OTP sudah ada.
  await q`UPDATE orders SET price = quantity * CASE country
      WHEN 'Indonesia' THEN 4500 WHEN 'Malaysia' THEN 5000
      WHEN 'Amerika Serikat' THEN 6000 WHEN 'Inggris' THEN 6500 ELSE 5000 END
    WHERE price IS NULL`;
  await q`UPDATE orders SET closed_at = updated_at WHERE closed_at IS NULL AND status = 'failed'`;
  const legacy = await q`SELECT id, otp, updated_at FROM orders WHERE closed_at IS NULL AND status = 'done'`;
  for (const o of legacy) {
    if (/\d{4,}/.test(String(o.otp ?? ""))) {
      await q`UPDATE orders SET closed_at = ${new Date(o.updated_at).toISOString()} WHERE id = ${o.id}`;
    }
  }

  await q`INSERT INTO settings (key, value) VALUES ('schema_v', ${SCHEMA_V})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

/** Membuat/menyesuaikan tabel otomatis saat pertama kali dipakai. Mengembalikan fungsi sql (tagged template). */
export async function db() {
  if (!ready) {
    ready = (async () => {
      try {
        await createSchema();
      } catch (e) {
        // Dua instance bisa migrasi bersamaan; coba sekali lagi.
        await new Promise((r) => setTimeout(r, 400));
        await createSchema();
      }
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  await ready;
  return client();
}
