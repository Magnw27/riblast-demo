/** Pengaturan yang bisa diubah admin lewat bot. Disimpan di tabel `settings` (tanpa env baru). */

export const COUNTRIES = {
  Indonesia: { code: "+62", price: 4500, alias: ["id", "indo", "indonesia"] },
  Malaysia: { code: "+60", price: 5000, alias: ["my", "malay", "malaysia"] },
  Inggris: { code: "+44", price: 6500, alias: ["uk", "gb", "ing", "inggris", "england"] },
  "Amerika Serikat": { code: "+1", price: 6000, alias: ["us", "usa", "as", "amerika"] },
};

export async function allSettings(q) {
  const rows = await q`SELECT key, value FROM settings`;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setSetting(q, key, value) {
  await q`INSERT INTO settings (key, value) VALUES (${key}, ${String(value)})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

export async function delSetting(q, key) {
  await q`DELETE FROM settings WHERE key = ${key}`;
}

export function priceOf(s, country) {
  const v = parseInt(s?.[`price:${country}`], 10);
  return v > 0 ? v : COUNTRIES[country]?.price ?? 5000;
}

export const inStock = (s, country) => s?.[`stock:${country}`] !== "off";
export const isMaintenance = (s) => s?.maintenance === "1";

/** Cocokkan teks bebas ("indo", "us", "Amerika Serikat") ke nama negara. */
export function resolveCountry(input) {
  const t = String(input ?? "").trim().toLowerCase();
  if (!t) return null;
  for (const [name, c] of Object.entries(COUNTRIES)) {
    if (name.toLowerCase() === t || c.alias.includes(t) || c.code === t) return name;
  }
  for (const name of Object.keys(COUNTRIES)) if (name.toLowerCase().startsWith(t)) return name;
  return null;
}

export function publicConfig(s) {
  return {
    countries: Object.entries(COUNTRIES).map(([name, c]) => ({
      name,
      code: c.code,
      price: priceOf(s, name),
      available: inStock(s, name),
    })),
    maintenance: { on: isMaintenance(s), message: s.maintenance_msg || "" },
    announcement: s.announce || "",
    wa: s.wa || "",
  };
}
