'use strict';
/**
 * Antrean perintah aktuator (server → ESP32 aktuator) dengan PAGAR KESELAMATAN di server.
 *
 * Prinsip: siapa pun yang meminta (pengguna, otomasi, AI) HANYA bisa mengantre perintah
 * yang lolos pagar di sini. AI/otomasi tidak pernah mengirim nilai mentah ke perangkat —
 * semua nilai divalidasi ulang terhadap `konfigurasi_dosis`, lock penampung, batas harian
 * dan latch E-STOP. Firmware ESP32 WAJIB punya batas sendiri juga (pertahanan berlapis).
 */
const { pool, q, one } = require('./db');

const TIPE = ['DOSIS', 'BILAS', 'SAMPLING', 'ISI_AIR', 'STOP', 'STOP_DARURAT'];
const LARUTAN = ['AB', 'PH_UP', 'PH_DOWN'];
const PERANGKAT_AKTUATOR = 'aktuator-01';

class PerintahDitolak extends Error {
  constructor(status, pesan, errors) {
    super(pesan);
    this.status = status;
    this.errors = errors;
  }
}

/** Peta konfigurasi_dosis → {param: number}. */
async function bacaKonfig(runner = q) {
  const rows = await runner('SELECT param, nilai FROM konfigurasi_dosis', []);
  const m = {};
  for (const r of rows.rows ?? rows) m[r.param] = Number(r.nilai);
  return m;
}

const angka = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const bulat1 = (n) => Math.round(n * 10) / 10;

/**
 * Validasi murni (tanpa DB). Mengembalikan parameter ter-normalisasi atau melempar 422.
 * @param {string} tipe
 * @param {object} p
 * @param {Record<string,number>} cfg konfigurasi_dosis
 */
function validasiPerintah(tipe, p, cfg) {
  if (!TIPE.includes(tipe)) throw new PerintahDitolak(422, 'Tipe perintah tidak dikenal.', { tipe: [`Pilih salah satu: ${TIPE.join(', ')}.`] });
  const body = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  const err = {};
  const out = {};
  const penampung = () => {
    const n = angka(body.penampung);
    if (!Number.isInteger(n) || n < 1 || n > 999999) err.penampung = ['penampung wajib berupa id meja (bilangan bulat ≥ 1).'];
    else out.penampung = n;
  };
  if (tipe === 'DOSIS') {
    penampung();
    if (!LARUTAN.includes(body.larutan)) err.larutan = [`larutan harus salah satu dari ${LARUTAN.join(', ')}.`];
    else out.larutan = body.larutan;
    const ml = angka(body.ml);
    if (!Number.isFinite(ml) || ml <= 0) err.ml = ['ml wajib angka > 0.'];
    else {
      const batas = body.larutan === 'AB'
        ? (cfg.maks_ml_per_suntikan ?? 214)
        : (cfg.maks_ml_ph_per_suntikan ?? 10);
      if (ml > batas) err.ml = [`ml melebihi batas per suntikan (${batas} mL).`];
      else out.ml = bulat1(ml);
    }
  } else if (tipe === 'BILAS') {
    penampung();
    const ml = angka(body.ml ?? 100);
    const batas = cfg.maks_ml_bilas_per_perintah ?? 500;
    if (!Number.isFinite(ml) || ml <= 0 || ml > batas) err.ml = [`ml bilas harus 1–${batas}.`];
    else out.ml = bulat1(ml);
  } else if (tipe === 'SAMPLING') {
    penampung();
  } else if (tipe === 'ISI_AIR') {
    penampung();
    const aksi = String(body.aksi || 'MULAI').toUpperCase();
    if (!['MULAI', 'STOP'].includes(aksi)) err.aksi = ['aksi harus MULAI atau STOP.'];
    else out.aksi = aksi;
  }
  if (Object.keys(err).length) throw new PerintahDitolak(422, 'Data tidak valid.', err);
  return out;
}

/** Perintah yang menambah risiko (butuh pagar penuh & ditolak saat E-STOP). */
const berisiko = (tipe, param) => tipe === 'DOSIS' || tipe === 'BILAS' || tipe === 'SAMPLING'
  || (tipe === 'ISI_AIR' && param.aksi === 'MULAI');

/**
 * Antre perintah. Atomik (transaksi) — pagar, penghitung harian, dan INSERT satu kesatuan.
 * @returns {Promise<object>} baris perintah_aktuator
 */
async function buatPerintah({ tipe, parameter, sumber = 'pengguna', userId = null, alasan = null, ttlDetik = 120, perangkat = PERANGKAT_AKTUATOR }) {
  const ttl = Math.min(600, Math.max(10, Number(ttlDetik) || 120));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cfg = await bacaKonfig((t, pr) => client.query(t, pr));
    const param = validasiPerintah(tipe, parameter, cfg);

    const dev = (await client.query('SELECT kode, peran FROM perangkat WHERE kode = $1', [perangkat])).rows[0];
    if (!dev || dev.peran !== 'aktuator') throw new PerintahDitolak(404, 'Perangkat aktuator tidak ditemukan.');

    const estop = (await client.query("SELECT nilai FROM aktuator_state WHERE kunci = 'estop' FOR UPDATE")).rows[0]?.nilai === '1';
    if (estop && berisiko(tipe, param)) {
      throw new PerintahDitolak(423, 'E-STOP aktif — semua perintah berisiko ditolak sampai di-reset oleh admin.');
    }

    if (berisiko(tipe, param)) {
      const antre = Number((await client.query(
        "SELECT count(*) FROM perintah_aktuator WHERE perangkat_kode = $1 AND status IN ('menunggu','dikirim')", [perangkat])).rows[0].count);
      if (antre >= 10) throw new PerintahDitolak(429, 'Antrean perintah penuh (maks 10). Tunggu perintah sebelumnya selesai.');
      const meja = (await client.query('SELECT 1 FROM mejas WHERE id_meja = $1', [param.penampung])).rows[0];
      if (!meja) throw new PerintahDitolak(404, 'Penampung (meja) tidak ditemukan.');
    }

    if (tipe === 'DOSIS') {
      // state penampung: buat bila belum ada, kunci baris, reset harian bila lewat tengah malam (WITA)
      await client.query('INSERT INTO penampung_states (id_meja) VALUES ($1) ON CONFLICT (id_meja) DO NOTHING', [param.penampung]);
      const st = (await client.query(
        `SELECT *, (reset_harian_pada IS NULL OR reset_harian_pada::date < (now() AT TIME ZONE 'Asia/Makassar')::date) AS perlu_reset
           FROM penampung_states WHERE id_meja = $1 FOR UPDATE`, [param.penampung])).rows[0];
      let { volume_ab_hari_ml: ab, volume_ph_hari_ml: ph, kejadian_dosis_hari: kej } = st;
      if (st.perlu_reset) { ab = 0; ph = 0; kej = 0; }
      ab = Number(ab); ph = Number(ph);
      if (st.status_lock) throw new PerintahDitolak(423, `Penampung terkunci${st.lock_alasan ? ` (${st.lock_alasan})` : ''} — dosis ditolak.`);
      if (st.mode_pemeliharaan && sumber !== 'pengguna') throw new PerintahDitolak(423, 'Penampung dalam mode pemeliharaan — dosis otomatis ditolak.');
      if (param.larutan === 'AB') {
        const batas = cfg.maks_volume_ab_hari_ml ?? 500;
        if (ab + param.ml > batas) throw new PerintahDitolak(409, `Batas volume AB harian tercapai (${ab}/${batas} mL).`);
        ab += param.ml; kej += 1;
      } else {
        const batas = cfg.maks_volume_ph_hari_ml ?? 100;
        if (ph + param.ml > batas) throw new PerintahDitolak(409, `Batas volume pH harian tercapai (${ph}/${batas} mL).`);
        ph += param.ml;
      }
      await client.query(
        `UPDATE penampung_states SET volume_ab_hari_ml = $2, volume_ph_hari_ml = $3, kejadian_dosis_hari = $4,
                reset_harian_pada = now(), updated_at = now() WHERE id_meja = $1`,
        [param.penampung, ab, ph, kej]);
    }

    if (tipe === 'STOP_DARURAT') {
      await client.query("UPDATE aktuator_state SET nilai = '1', diubah_pada = now() WHERE kunci = 'estop'");
      await client.query(
        "UPDATE perintah_aktuator SET status = 'batal', selesai_pada = now() WHERE perangkat_kode = $1 AND status = 'menunggu'", [perangkat]);
    }

    const row = (await client.query(
      `INSERT INTO perintah_aktuator (perangkat_kode, tipe, parameter, sumber, dibuat_oleh, alasan, kedaluwarsa_pada)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval)
       RETURNING id, perangkat_kode, tipe, parameter, status, sumber, alasan, kedaluwarsa_pada, dibuat_pada`,
      [perangkat, tipe, param, sumber, userId, alasan ? String(alasan).slice(0, 200) : null, String(ttl)])).rows[0];
    await client.query('COMMIT');
    return row;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Bersihkan antrean: menunggu kedaluwarsa → 'kedaluwarsa'; dikirim >90 dtk tanpa hasil → 'gagal'. */
async function rapikanAntrean(perangkat) {
  await q(
    `UPDATE perintah_aktuator SET status = 'kedaluwarsa', selesai_pada = now()
      WHERE perangkat_kode = $1 AND status = 'menunggu' AND kedaluwarsa_pada <= now()`, [perangkat]);
  await q(
    `UPDATE perintah_aktuator SET status = 'gagal', selesai_pada = now(), hasil = '{"error":"timeout_tanpa_laporan"}'
      WHERE perangkat_kode = $1 AND status = 'dikirim' AND dikirim_pada <= now() - interval '90 seconds'`, [perangkat]);
}

/** Ambil perintah menunggu untuk perangkat (atomik, tiap perintah hanya terkirim sekali). */
async function ambilPerintah(perangkat, maks = 5) {
  await rapikanAntrean(perangkat);
  const rows = await q(
    `UPDATE perintah_aktuator SET status = 'dikirim', dikirim_pada = now()
      WHERE id IN (
        SELECT id FROM perintah_aktuator
         WHERE perangkat_kode = $1 AND status = 'menunggu' AND kedaluwarsa_pada > now()
         ORDER BY (tipe = 'STOP_DARURAT') DESC, (tipe = 'STOP') DESC, id
         LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING id, tipe, parameter, kedaluwarsa_pada`,
    [perangkat, Math.min(10, Math.max(1, Number(maks) || 5))]);
  return rows.sort((a, b) => Number(a.id) - Number(b.id));
}

/** Laporan hasil dari perangkat. Hanya perintah miliknya & berstatus 'dikirim'. */
async function laporHasil(perangkat, id, { status, hasil }) {
  if (!['selesai', 'gagal'].includes(status)) throw new PerintahDitolak(422, 'Data tidak valid.', { status: ['status harus selesai atau gagal.'] });
  const aman = hasil && typeof hasil === 'object' && !Array.isArray(hasil) && JSON.stringify(hasil).length <= 2000 ? hasil : null;
  const row = await one(
    `UPDATE perintah_aktuator SET status = $3, selesai_pada = now(), hasil = $4
      WHERE id = $1 AND perangkat_kode = $2 AND status = 'dikirim'
      RETURNING id, tipe, parameter, status, hasil`,
    [id, perangkat, status, aman]);
  if (!row) throw new PerintahDitolak(404, 'Perintah tidak ditemukan atau sudah dilaporkan.');
  // dosis yang GAGAL dilaporkan tidak menghabiskan jatah harian: kembalikan reservasi
  if (status === 'gagal' && row.tipe === 'DOSIS') {
    const { penampung, larutan, ml } = row.parameter;
    const kol = larutan === 'AB' ? 'volume_ab_hari_ml' : 'volume_ph_hari_ml';
    await q(`UPDATE penampung_states SET ${kol} = GREATEST(0, ${kol} - $2), updated_at = now() WHERE id_meja = $1`, [penampung, ml]);
  }
  return row;
}

async function resetEstop() {
  await q("UPDATE aktuator_state SET nilai = '0', diubah_pada = now() WHERE kunci = 'estop'");
}
async function statusEstop() {
  return (await one("SELECT nilai, diubah_pada FROM aktuator_state WHERE kunci = 'estop'")) || { nilai: '0' };
}

module.exports = {
  TIPE, LARUTAN, PERANGKAT_AKTUATOR, PerintahDitolak,
  bacaKonfig, validasiPerintah, buatPerintah, ambilPerintah, laporHasil, rapikanAntrean, resetEstop, statusEstop,
};
