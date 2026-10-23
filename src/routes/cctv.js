'use strict';
/**
 * Papan kamera CCTV.
 *   GET    /cctv        semua role (daftar kamera)
 *   POST   /cctv        admin   { nama, lokasi?, tipe: 'mjpeg'|'snapshot'|'rtsp', url, interval_detik?, aktif? }
 *   PUT    /cctv/:id    admin
 *   DELETE /cctv/:id    admin
 *   GET    /cctv/:id/gambar  semua role — satu frame JPEG dari kamera RTSP (lewat ffmpeg di server)
 * 'mjpeg'/'snapshot': browser menarik gambar LANGSUNG dari URL http(s) kamera.
 * 'rtsp' (EZVIZ, kamera IP biasa): URL rtsp(s):// berisi sandi kamera TIDAK pernah dikirim utuh ke
 *   browser (sandi disamarkan `***`); gambar diambil server dan disajikan lewat /cctv/:id/gambar
 *   — butuh login, HP tidak perlu satu jaringan dengan kamera, tanpa mixed content.
 * Demo hanya baca. Tabel dibuat otomatis (idempoten) bila belum ada.
 */
const express = require('express');
const { spawn } = require('node:child_process');
const { q, one } = require('../db');
const { requireRole, demoGuard, json } = require('../auth');
const { idValid, notFound } = require('./_id');

const router = express.Router();
const tulis = [requireRole(['admin']), demoGuard('cctv.tulis')];

let siap = null;
function pastikanTabel() {
  if (!siap) {
    siap = q(`CREATE TABLE IF NOT EXISTS cctv_kameras (
      id bigserial PRIMARY KEY,
      nama varchar(100) NOT NULL,
      lokasi varchar(100),
      tipe varchar(10) NOT NULL DEFAULT 'snapshot' CHECK (tipe IN ('mjpeg', 'snapshot', 'rtsp')),
      url text NOT NULL,
      interval_detik integer NOT NULL DEFAULT 5 CHECK (interval_detik BETWEEN 1 AND 60),
      aktif boolean NOT NULL DEFAULT true,
      created_at timestamp(0) without time zone DEFAULT now() NOT NULL,
      updated_at timestamp(0) without time zone
    )`).catch((e) => { siap = null; throw e; });
  }
  return siap;
}

function bersih(v) {
  return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

const TIPE = ['mjpeg', 'snapshot', 'rtsp'];
const SAMARAN = '***';

/** Sandi di URL diganti `***` — URL RTSP berisi kode verifikasi kamera. */
function samarkan(url) {
  try {
    const p = new URL(url);
    if (p.password) p.password = SAMARAN;
    return p.toString();
  } catch { return ''; }
}

/** Baris untuk browser: URL RTSP selalu disamarkan; non-admin tidak menerima URL RTSP sama sekali. */
function tampil(row, admin) {
  if (row.tipe !== 'rtsp') return row;
  return { ...row, url: admin ? samarkan(row.url) : null };
}

const adminSungguhan = (req) => req.user && req.user.level === 'admin' && !req.user.demo;

/** URL sesuai tipe: rtsp(s):// untuk 'rtsp', http(s):// untuk lainnya. */
function urlCocok(url, tipe) {
  try {
    const p = new URL(url);
    const boleh = tipe === 'rtsp' ? ['rtsp:', 'rtsps:'] : ['http:', 'https:'];
    return boleh.includes(p.protocol) && Boolean(p.hostname) && url.length <= 500;
  } catch { return false; }
}
const pesanUrl = (tipe) => (tipe === 'rtsp'
  ? ['URL RTSP harus diawali rtsp:// (maks 500 karakter), mis. rtsp://admin:KODE@192.168.1.60:554/ch1/main.']
  : ['URL harus diawali http:// atau https:// (maks 500 karakter).']);

/** @returns {{ok:true,data:object}|{ok:false,errors:object}} */
function periksa(body, parsial) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const out = {};
  const ada = (k) => b[k] !== undefined;

  if (!parsial || ada('nama')) {
    const nama = bersih(b.nama);
    if (!nama) errors.nama = ['Nama kamera wajib diisi.'];
    else if (nama.length > 100) errors.nama = ['Nama maksimal 100 karakter.'];
    else out.nama = nama;
  }
  if (ada('lokasi')) {
    const l = bersih(b.lokasi);
    if (l.length > 100) errors.lokasi = ['Lokasi maksimal 100 karakter.'];
    else out.lokasi = l || null;
  }
  if (!parsial || ada('tipe')) {
    const t = bersih(b.tipe || 'snapshot');
    if (!TIPE.includes(t)) errors.tipe = ["Tipe harus 'mjpeg', 'snapshot', atau 'rtsp'."];
    else out.tipe = t;
  }
  if (!parsial || ada('url')) {
    const u = bersih(b.url);
    // tipe diketahui → protokol harus cocok; tipe tidak dikirim/tidak sah → cukup salah satu protokol yang dikenal
    // (PUT yang hanya mengubah salah satunya diperiksa lagi di handler terhadap baris tersimpan)
    const ok = out.tipe ? urlCocok(u, out.tipe) : urlCocok(u, 'snapshot') || urlCocok(u, 'rtsp');
    if (!ok) errors.url = pesanUrl(out.tipe);
    else out.url = u;
  }
  if (ada('interval_detik')) {
    const n = Number(b.interval_detik);
    if (!Number.isInteger(n) || n < 1 || n > 60) errors.interval_detik = ['Interval harus bilangan bulat 1–60 detik.'];
    else out.interval_detik = n;
  }
  if (ada('aktif')) {
    if (typeof b.aktif !== 'boolean') errors.aktif = ['Aktif harus true atau false.'];
    else out.aktif = b.aktif;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, data: out };
}

router.get('/', async (req, res, next) => {
  try {
    await pastikanTabel();
    const rows = await q('SELECT * FROM cctv_kameras ORDER BY id');
    const admin = adminSungguhan(req);
    res.json({ page: 'cctv', list: rows.map((r) => tampil(r, admin)) });
  } catch (e) { next(e); }
});

/* ── Frame RTSP → JPEG (ffmpeg) ──────────────────────────────────────
 * Cache per kamera (≥ 2 dtk; penonton bersamaan berbagi satu frame), satu proses per kamera
 * sekaligus, maks MAKS_PROSES ffmpeg bersamaan (Pi lemah), batas waktu & batas ukuran keluaran. */
const FFMPEG = process.env.CCTV_FFMPEG || 'ffmpeg';
const BATAS_MS = Number(process.env.CCTV_TIMEOUT_MS || 12000);
const MAKS_PROSES = 2;
const MAKS_BYTE = 4 * 1024 * 1024;
const cache = new Map(); // id → { diambil, jpeg, janji }
let berjalan = 0;

function ambilFrame(url) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', '8000000',
      '-i', url, '-frames:v', '1', '-vf', 'scale=min(1280\\,iw):-2', '-q:v', '5', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'];
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const keping = []; let ukuran = 0; let galat = '';
    const jam = setTimeout(() => p.kill('SIGKILL'), BATAS_MS);
    p.stdout.on('data', (d) => { ukuran += d.length; if (ukuran > MAKS_BYTE) p.kill('SIGKILL'); else keping.push(d); });
    p.stderr.on('data', (d) => { if (galat.length < 2000) galat += d; });
    p.on('error', (e) => { clearTimeout(jam); reject(new Error(e.code === 'ENOENT' ? 'ffmpeg tidak terpasang' : e.message)); });
    p.on('close', (kode) => {
      clearTimeout(jam);
      const jpeg = Buffer.concat(keping);
      // JPEG sah diawali FF D8
      if (kode === 0 && jpeg.length > 2 && jpeg[0] === 0xff && jpeg[1] === 0xd8) resolve(jpeg);
      else reject(new Error(galat.trim().split('\n').pop() || `ffmpeg keluar dengan kode ${kode}`));
    });
  });
}

router.get('/:id/gambar', async (req, res, next) => {
  try {
    if (!idValid(req)) return notFound(res);
    await pastikanTabel();
    const k = await one('SELECT id, tipe, url, aktif, interval_detik FROM cctv_kameras WHERE id = $1', [req.params.id]);
    if (!k || k.tipe !== 'rtsp') return notFound(res);
    if (!k.aktif) return json(res, 409, { message: 'Kamera dinonaktifkan.' });

    const kunci = String(k.id);
    let c = cache.get(kunci);
    const segar = Math.max(2000, (k.interval_detik * 1000) / 2);
    if (!(c && c.jpeg && Date.now() - c.diambil < segar && c.url === k.url)) {
      if (!(c && c.janji && c.url === k.url)) {
        if (berjalan >= MAKS_PROSES) return json(res, 503, { message: 'Server sedang mengambil gambar kamera lain. Coba lagi sebentar.' });
        berjalan += 1;
        const janji = ambilFrame(k.url).finally(() => { berjalan -= 1; });
        c = { ...(c && c.url === k.url ? c : {}), url: k.url, janji };
        cache.set(kunci, c);
        janji.then(
          (jpeg) => cache.set(kunci, { url: k.url, jpeg, diambil: Date.now() }),
          (e) => {
            cache.set(kunci, { url: k.url, jpeg: null, diambil: 0 });
            // jangan pernah mencatat sandi kamera
            console.warn(`[cctv] kamera ${kunci} gagal: ${String(e.message).replaceAll(k.url, samarkan(k.url))}`);
          },
        );
      }
      try {
        await cache.get(kunci).janji;
      } catch {
        return json(res, 502, { message: 'Kamera tidak merespons. Periksa kamera menyala, satu jaringan dengan server, dan URL RTSP-nya.' });
      }
      c = cache.get(kunci);
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Diambil-Pada', new Date(c.diambil).toISOString());
    return res.end(c.jpeg);
  } catch (e) { return next(e); }
});

router.post('/', ...tulis, async (req, res, next) => {
  try {
    const v = periksa(req.body, false);
    if (!v.ok) return json(res, 422, { message: 'Data tidak valid.', errors: v.errors });
    await pastikanTabel();
    const d = v.data;
    const row = await one(
      `INSERT INTO cctv_kameras (nama, lokasi, tipe, url, interval_detik, aktif)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [d.nama, d.lokasi ?? null, d.tipe, d.url, d.interval_detik ?? 5, d.aktif ?? true],
    );
    return res.status(201).json({ status: true, message: 'Kamera ditambahkan.', data: tampil(row, true) });
  } catch (e) { return next(e); }
});

router.put('/:id', ...tulis, async (req, res, next) => {
  try {
    if (!idValid(req)) return notFound(res);
    const v = periksa(req.body, true);
    if (!v.ok) return json(res, 422, { message: 'Data tidak valid.', errors: v.errors });
    if (!Object.keys(v.data).length) return json(res, 422, { message: 'Data tidak valid.', errors: { body: ['Tidak ada kolom yang diubah.'] } });
    await pastikanTabel();
    const lama = await one('SELECT tipe, url FROM cctv_kameras WHERE id = $1', [req.params.id]);
    if (!lama) return notFound(res);
    // URL samaran dari form ubah (`admin:***@`) → pakai sandi yang tersimpan
    if (v.data.url !== undefined) {
      try {
        const baru = new URL(v.data.url); const asal = new URL(lama.url);
        if (baru.password === SAMARAN) { baru.password = asal.password; v.data.url = baru.toString(); }
      } catch { /* diperiksa urlCocok di bawah */ }
    }
    const tipe = v.data.tipe ?? lama.tipe;
    const url = v.data.url ?? lama.url;
    if ((v.data.tipe !== undefined || v.data.url !== undefined) && !urlCocok(url, tipe)) {
      return json(res, 422, { message: 'Data tidak valid.', errors: { url: pesanUrl(tipe) } });
    }
    const kolom = Object.keys(v.data);
    const set = kolom.map((k, i) => `${k} = $${i + 1}`).concat('updated_at = now()');
    const row = await one(
      `UPDATE cctv_kameras SET ${set.join(', ')} WHERE id = $${kolom.length + 1} RETURNING *`,
      [...kolom.map((k) => v.data[k]), req.params.id],
    );
    if (!row) return notFound(res);
    cache.delete(String(row.id));
    return res.json({ status: true, message: 'Kamera diperbarui.', data: tampil(row, true) });
  } catch (e) { return next(e); }
});

router.delete('/:id', ...tulis, async (req, res, next) => {
  try {
    if (!idValid(req)) return notFound(res);
    await pastikanTabel();
    const row = await one('DELETE FROM cctv_kameras WHERE id = $1 RETURNING id', [req.params.id]);
    if (!row) return notFound(res);
    cache.delete(String(row.id));
    return res.json({ status: true, message: 'Kamera dihapus.' });
  } catch (e) { return next(e); }
});

module.exports = router;
module.exports.samarkan = samarkan;
module.exports.urlCocok = urlCocok;
