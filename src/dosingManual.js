'use strict';
/**
 * Nutrisi Manual (dosing manual dari aplikasi) — validasi + pencatatan.
 *
 * Tidak terpengaruh saklar (override manual). Fail-safe tetap berlaku: LOCK penampung, E-STOP,
 * batas per sekali dosing, jatah volume harian, dan jeda minimum antar dosing (semua dari konfigurasi_dosis/timing_operasi).
 *
 * EKSEKUSI FISIK TERKUNCI (gerbangDosis.EKSEKUSI_DIIZINKAN=false, keputusan pemilik): permintaan yang lolos validasi
 * dicatat sebagai dosing_events (pemicu USER_MANUAL) + dosing_rounds berstatus GAGAL, alasan 'eksekusi_diblokir',
 * dan TIDAK ada perintah pompa yang dibuat. Modul ini sengaja tidak memanggil buatPerintah (lihat otomasi-blokir.test.js).
 */
const { pool, q } = require('./db');
const { EKSEKUSI_DIIZINKAN } = require('./gerbangDosis');
const { BAWAAN_V41 } = require('./iotV41');

const ZAT = {
  nutrisi_a: { jenis: 'A', nama: 'Nutrisi A', batas: 'maks_ml_per_suntikan', bawaanBatas: 214, laju: 'laju_pompa_a_mls', bawaanLaju: BAWAAN_V41.laju_a, hari: 'maks_volume_ab_hari_ml', kolomHari: 'volume_ab_hari_ml', bawaanHari: 500 },
  nutrisi_b: { jenis: 'B', nama: 'Nutrisi B', batas: 'maks_ml_per_suntikan', bawaanBatas: 214, laju: 'laju_pompa_b_mls', bawaanLaju: BAWAAN_V41.laju_b, hari: 'maks_volume_ab_hari_ml', kolomHari: 'volume_ab_hari_ml', bawaanHari: 500 },
  ph_up: { jenis: 'PH_UP', nama: 'pH Up', batas: 'maks_ml_ph_per_suntikan', bawaanBatas: 10, laju: 'laju_pompa_ph_up_mls', bawaanLaju: BAWAAN_V41.laju_ph_up, hari: 'maks_volume_ph_hari_ml', kolomHari: 'volume_ph_hari_ml', bawaanHari: 100 },
  ph_down: { jenis: 'PH_DOWN', nama: 'pH Down', batas: 'maks_ml_ph_per_suntikan', bawaanBatas: 10, laju: 'laju_pompa_ph_down_mls', bawaanLaju: BAWAAN_V41.laju_ph_down, hari: 'maks_volume_ph_hari_ml', kolomHari: 'volume_ph_hari_ml', bawaanHari: 100 },
};
const DURASI_MAKS_DETIK = 600;

class ManualDitolak extends Error {
  constructor(status, pesan, errors, kode) { super(pesan); this.status = status; this.errors = errors; this.kode = kode; }
}

const angka = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const bulat1 = (n) => Math.round(n * 10) / 10;

/** Validasi murni (tanpa DB). cfg = peta param → angka. Mengembalikan {zat, def, ml, durasi_detik}. */
function validasi(body, cfg) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const err = {};
  const def = ZAT[b.zat];
  if (!def) err.zat = [`zat harus salah satu dari ${Object.keys(ZAT).join(', ')}.`];
  const adaMl = b.volume_ml !== undefined && b.volume_ml !== null && b.volume_ml !== '';
  const adaDur = b.durasi_detik !== undefined && b.durasi_detik !== null && b.durasi_detik !== '';
  if (adaMl === adaDur) err.volume_ml = ['isi salah satu: volume_ml ATAU durasi_detik.'];
  let ml = NaN;
  let durasi = null;
  if (def && adaMl !== adaDur) {
    const batas = cfg[def.batas] ?? def.bawaanBatas;
    const laju = cfg[def.laju] ?? def.bawaanLaju;
    if (adaMl) {
      ml = angka(b.volume_ml);
      if (!Number.isFinite(ml) || ml <= 0) err.volume_ml = ['volume_ml wajib angka > 0.'];
    } else {
      durasi = angka(b.durasi_detik);
      if (!Number.isFinite(durasi) || durasi <= 0 || durasi > DURASI_MAKS_DETIK) err.durasi_detik = [`durasi_detik harus 1–${DURASI_MAKS_DETIK}.`];
      else if (!(laju > 0)) err.durasi_detik = ['laju pompa belum dikalibrasi; pakai volume_ml.'];
      else ml = durasi * laju;
    }
    if (Number.isFinite(ml) && ml > batas) err[adaMl ? 'volume_ml' : 'durasi_detik'] = [`melebihi batas ${batas} mL per sekali dosing (${bulat1(ml)} mL diminta).`];
    if (Number.isFinite(ml) && !err.volume_ml && !err.durasi_detik) {
      ml = bulat1(ml);
      if (ml <= 0) err.volume_ml = ['volume terlalu kecil.'];
      if (durasi === null) durasi = laju > 0 ? Math.round((ml / laju) * 10) / 10 : null;
    }
  }
  if (Object.keys(err).length) return { ok: false, errors: err };
  return { ok: true, zat: b.zat, def, ml, durasi_detik: durasi };
}

async function bacaCfg() {
  const [d, t] = await Promise.all([
    q('SELECT param, nilai FROM konfigurasi_dosis', []),
    q('SELECT param, nilai FROM timing_operasi', []),
  ]);
  const m = {};
  for (const r of [...d, ...t]) if (r.nilai !== null) m[r.param] = Number(r.nilai);
  return m;
}

/** Semua pagar yang butuh DB. Melempar ManualDitolak. Mengembalikan id_meja. */
async function pagar(hasil, cfg) {
  const meja = (await q('SELECT id_meja FROM mejas ORDER BY id_meja LIMIT 1', []))[0];
  if (!meja) throw new ManualDitolak(409, 'Kebun belum diatur (tidak ada penampung).');
  const idMeja = meja.id_meja;
  const estop = (await q("SELECT nilai FROM aktuator_state WHERE kunci = 'estop'", []))[0]?.nilai === '1';
  if (estop) throw new ManualDitolak(423, 'E-STOP aktif — dosing ditolak sampai di-reset oleh admin.', null, 'estop');
  const st = (await q(`SELECT status_lock, lock_alasan, mode_pemeliharaan, volume_ab_hari_ml, volume_ph_hari_ml, (reset_harian_pada IS NULL OR reset_harian_pada::date < (now() AT TIME ZONE 'Asia/Makassar')::date) AS perlu_reset FROM penampung_states WHERE id_meja = $1`, [idMeja]))[0];
  if (st?.status_lock) throw new ManualDitolak(423, `Penampung terkunci${st.lock_alasan ? ` (${st.lock_alasan})` : ''} — dosing ditolak.`, null, 'lock');
  const terpakai = st?.perlu_reset ? 0 : Number(st?.[hasil.def.kolomHari] ?? 0); // hari baru WITA = jatah 0
  const jatah = cfg[hasil.def.hari] ?? hasil.def.bawaanHari;
  if (terpakai + hasil.ml > jatah) {
    throw new ManualDitolak(409, `Jatah volume harian ${hasil.def.nama.startsWith('pH') ? 'pH' : 'nutrisi'} terlampaui (${terpakai}+${hasil.ml} > ${jatah} mL).`, null, 'jatah_harian');
  }
  const jeda = cfg.jeda_ec_menit ?? BAWAAN_V41.jeda_ec_menit;
  const terakhir = (await q(
    `SELECT extract(epoch FROM now() - mulai_pada)::int AS detik FROM dosing_events
      WHERE id_meja = $1 AND pemicu = 'USER_MANUAL' AND hasil IN ('berjalan','sukses') ORDER BY mulai_pada DESC LIMIT 1`, [idMeja]))[0];
  if (terakhir && terakhir.detik < jeda * 60) {
    const sisa = Math.ceil((jeda * 60 - terakhir.detik) / 60);
    throw new ManualDitolak(429, `Jeda minimum antar dosing ${jeda} menit. Tunggu ± ${sisa} menit lagi.`, null, 'jeda_minimum');
  }
  return idMeja;
}

/**
 * Catat satu permintaan dosing manual. `eksekusiDiizinkan` hanya untuk uji; produksi memakai gerbang.
 * @returns {{status:number, body:object}}
 */
async function dosingManual(body, user, { eksekusiDiizinkan = EKSEKUSI_DIIZINKAN } = {}) {
  const cfg = await bacaCfg();
  const v = validasi(body, cfg);
  if (!v.ok) throw new ManualDitolak(422, 'Data tidak valid.', v.errors);
  const idMeja = await pagar(v, cfg);
  const userId = Number(user.sub) || null;
  if (!userId) throw new ManualDitolak(403, 'Dosing manual wajib atas nama pengguna.');

  const alasan = `Nutrisi Manual: ${v.def.nama} ${v.ml} mL`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ev = (await client.query(
      `INSERT INTO dosing_events (id_meja, hari, pemicu, aktor_tipe, dipicu_oleh, alasan, ronde_total, volume_total_ml, hasil, selesai_pada, durasi_detik, alasan_akhir)
       VALUES ($1, (now() AT TIME ZONE 'Asia/Makassar')::date, 'USER_MANUAL', 'user', $2, $3, 1, 0, 'gagal', now(), 0, 'eksekusi_diblokir')
       RETURNING id`, [idMeja, userId, alasan])).rows[0];
    await client.query(
      `INSERT INTO dosing_rounds (id_kejadian, ronde_ke, jenis, volume_ml, durasi_pulse_detik, selesai_pada, hasil, catatan, ml_nyata)
       VALUES ($1, 1, $2, $3, $4, now(), 'gagal', $5, 0)`,
      [ev.id, v.def.jenis, v.ml, v.durasi_detik, 'Diminta dari Nutrisi Manual; eksekusi pompa dikunci, tidak ada perintah dikirim.']);
    await client.query('COMMIT');
    if (!eksekusiDiizinkan) {
      return { status: 423, body: {
        kode: 'eksekusi_diblokir', eksekusi_diizinkan: false, tervalidasi: true, id_kejadian: Number(ev.id),
        message: `Permintaan ${v.def.nama} ${v.ml} mL lolos validasi tetapi dosing dari aplikasi masih DIKUNCI. Dicatat sebagai gagal (eksekusi_diblokir); tidak ada pompa menyala.`,
        zat: v.zat, volume_ml: v.ml, durasi_detik: v.durasi_detik,
      } };
    }
    // Jalur eksekusi belum ada: membukanya butuh perubahan kode + review (lihat gerbangDosis).
    return { status: 501, body: { kode: 'belum_ada', message: 'Jalur eksekusi dosing manual belum dibuat.' } };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Riwayat dosing manual terakhir + ronde, untuk panel status (berjalan/selesai/gagal). */
async function riwayat(limit = 20) {
  const ev = await q(
    `SELECT e.id, e.mulai_pada, e.selesai_pada, e.hasil, e.alasan, e.alasan_akhir, e.volume_total_ml, u.username AS oleh
       FROM dosing_events e LEFT JOIN users u ON u.id = e.dipicu_oleh
      WHERE e.pemicu = 'USER_MANUAL' ORDER BY e.id DESC LIMIT $1`, [Math.min(100, Math.max(1, limit))]);
  if (!ev.length) return [];
  const rd = await q(
    'SELECT id_kejadian, ronde_ke, jenis, volume_ml, ml_nyata, hasil, catatan FROM dosing_rounds WHERE id_kejadian = ANY($1::bigint[]) ORDER BY id_kejadian, ronde_ke',
    [ev.map((e) => e.id)]);
  return ev.map((e) => ({ ...e, ronde: rd.filter((r) => String(r.id_kejadian) === String(e.id)) }));
}

/** Tandai dosing manual yang masih 'berjalan' sebagai dibatalkan (dipanggil saat tombol Batal/STOP). */
async function batalkanBerjalan() {
  const r = await q(
    `UPDATE dosing_events SET hasil = 'dibatalkan', selesai_pada = now(), alasan_akhir = 'dibatalkan_pengguna', updated_at = now()
      WHERE pemicu = 'USER_MANUAL' AND hasil = 'berjalan' RETURNING id`, []);
  return r.length;
}

/** Batas yang berlaku (untuk ditampilkan di form): maks mL per dosing, laju pompa, jeda minimum. */
async function batas() {
  const cfg = await bacaCfg();
  const per = Object.fromEntries(Object.entries(ZAT).map(([k, d]) => [k, {
    nama: d.nama, maks_ml: cfg[d.batas] ?? d.bawaanBatas, laju_ml_per_detik: cfg[d.laju] ?? d.bawaanLaju, jatah_harian_ml: cfg[d.hari] ?? d.bawaanHari,
  }]));
  return { zat: per, jeda_menit: cfg.jeda_ec_menit ?? BAWAAN_V41.jeda_ec_menit, durasi_maks_detik: DURASI_MAKS_DETIK };
}

module.exports = { batas, ZAT, ManualDitolak, validasi, dosingManual, riwayat, batalkanBerjalan };
