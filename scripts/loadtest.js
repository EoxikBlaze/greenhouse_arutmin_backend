'use strict';
/**
 * Load test — mensimulasikan N user bersamaan (default 1000) selama D detik.
 * Pemakaian:  ulimit -n 10240 && RATE_LIMIT_OFF=1 node scripts/loadtest.js [conc] [durasiDetik]
 * Metrik: total request, RPS, latency p50/p95/p99, error.
 * Beban campuran: 60% GET /api/latest-sensor · 25% GET /monitoring/chart-data (auth)
 *                  · 15% POST /api/save-sensor (ESP32)
 */
const BASE = process.env.LOAD_BASE || 'http://127.0.0.1:8000';
const CONC = Number(process.argv[2] || 1000);
const DUR = Number(process.argv[3] || 20);

async function login() {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '@adminbersabda123' }),
  });
  return (await res.json()).token;
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const i = Math.min(arr.length - 1, Math.floor((p / 100) * arr.length));
  return arr[i];
}

(async () => {
  const token = await login();
  const espKey = process.env.ESP32_API_KEY || '';
  const lat = [];
  let n = 0, err = 0, byKind = {};
  const statusCounts = {};
  const errSamples = [];
  const deadline = Date.now() + DUR * 1000;

  async function worker(id) {
    while (Date.now() < deadline) {
      const r = id % 20;
      const kind = r < 12 ? 'latest' : r < 17 ? 'chart' : 'save';
      const t0 = process.hrtime.bigint();
      try {
        let res;
        if (kind === 'latest') {
          res = await fetch(`${BASE}/api/latest-sensor`);
        } else if (kind === 'chart') {
          res = await fetch(`${BASE}/monitoring/chart-data`, { headers: { Authorization: `Bearer ${token}` } });
        } else {
          res = await fetch(`${BASE}/api/save-sensor`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': espKey },
            body: JSON.stringify({ waterTemp: 26, ph: 6.4, tds: 1180, airTemp: 31, humidity: 68, water_level: 'Load' }),
          });
        }
        await res.arrayBuffer();
        statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
        if (res.status >= 500) {
          err++;
          if (errSamples.length < 5) errSamples.push({ kind, status: res.status });
        }
        byKind[kind] = (byKind[kind] || 0) + 1;
        n++;
        lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
      } catch (e) {
        err++;
        if (errSamples.length < 5) errSamples.push({ kind, exc: String(e && e.message || e) });
      }
    }
  }

  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));
  const elapsed = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);

  console.log(JSON.stringify({
    concurrency: CONC,
    duration_s: elapsed.toFixed(1),
    total_requests: n,
    rps: Math.round(n / elapsed),
    errors_5xx: err,
    status_counts: statusCounts,
    error_samples: errSamples,
    latency_ms: {
      p50: +pct(lat, 50).toFixed(1),
      p95: +pct(lat, 95).toFixed(1),
      p99: +pct(lat, 99).toFixed(1),
      max: +(lat[lat.length - 1] || 0).toFixed(1),
    },
    by_kind: byKind,
  }, null, 2));
})();
