'use strict';
/**
 * Rate limiter — pembatas spam untuk POST / GET / view (per IP).
 * Fixed-window counter + pruning otomatis agar Map TIDAK bocor memori.
 */
const buckets = new Map(); // key -> { count, resetAt }

function prune(now) {
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
  // hard cap: kalau banjir IP aneh, bersihkan yang hampir kedaluwarsa
  if (buckets.size > 50_000) {
    const soon = now + 1000;
    for (const [k, v] of buckets) {
      if (v.resetAt <= soon) buckets.delete(k);
    }
    if (buckets.size > 50_000) buckets.clear();
  }
}

const sweeper = setInterval(() => prune(Date.now()), 30_000);
if (sweeper.unref) sweeper.unref();

/**
 * @param {{windowMs?:number, max:number, name?:string, methods?:string[]}} opts
 */
function rateLimit(opts) {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max;
  const methods = opts.methods || null; // null = semua method
  return (req, res, next) => {
    if (methods && !methods.includes(req.method)) return next();
    const now = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${opts.name || 'global'}|${ip}`;
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      const sisa = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(sisa));
      return res.status(429).json({ message: `Terlalu banyak permintaan. Coba lagi dalam ${sisa} detik.` });
    }
    // jangan timpa header dari limiter lain yang lebih spesifik
    if (!res.getHeader('X-RateLimit-Limit')) {
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - b.count)));
    }
    next();
  };
}

module.exports = { rateLimit };
