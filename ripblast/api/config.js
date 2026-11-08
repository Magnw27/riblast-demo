import { db } from "./_lib/db.js";
import { send, serverError } from "./_lib/http.js";
import { allSettings, publicConfig } from "./_lib/settings.js";
import { responseStats } from "./_lib/orders.js";

let cache = { at: 0, data: null };
const TTL = 15_000;

/** Statistik nyata; baru ditampilkan kalau datanya sudah cukup supaya tidak menyesatkan. */
async function publicStats(q) {
  const [r] = await q`SELECT count(*)::int AS total,
      COALESCE(sum(CASE WHEN status = 'done' AND closed_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS done,
      COALESCE(sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed
    FROM orders`;
  if (r.total < 10 || r.done + r.failed < 5) return null;
  const resp = await responseStats(q);
  return {
    orders: r.total,
    successRate: Math.round((r.done / (r.done + r.failed)) * 100),
    avgReplyMin: resp.n >= 5 ? Math.max(1, Math.round(resp.avgMin)) : null,
  };
}

export default async function handler(req, res) {
  try {
    if (Date.now() - cache.at > TTL || !cache.data) {
      const q = await db();
      const settings = await allSettings(q);
      cache = { at: Date.now(), data: { ...publicConfig(settings), stats: await publicStats(q) } };
    }
    return send(res, 200, cache.data);
  } catch (e) {
    return serverError(res, e, "config");
  }
}
