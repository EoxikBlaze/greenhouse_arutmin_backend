'use strict';
/**
 * Grafik "Nutrisi: target vs aktual" (menu Sensor) — GET /monitoring/nutrisi.
 *   aktual      : ppm rata-rata per jam dari sensor (monitorings.tds; tds = ppm = EC × 500)
 *   target_alat : target yang BENAR-BENAR dikirim ke alat (perintah SEMAI/TARGET yang dikonfirmasi alat) — garis bertangga
 *   rencana     : target kurva batch untuk hari-hari ke depan (per siklus: tetap sampai tahap dikonfirmasi pindah)
 *   dosing      : kapan alat menyuntik (dosing_kejadian, dicatat dari hitungan harian yang dilaporkan alat)
 */
const { q, one } = require('./db');
const P = require('./presetDosing');
const S = require('./sinkronAlat');
const { bacaKeadaanAlat } = require('./keadaanAlat');

const JENIS_DOSING = { dosing_ab_hari: 'AB', dosing_ph_hari: 'PH', encer_hari: 'ENCER', isi_hari: 'ISI' };
/** Satu laporan alat tidak mungkin menambah lebih dari ini; selisih lebih besar = reset/loncatan, bukan kejadian. */
const MAKS_PER_LAPORAN = 5;

/**
 * Kejadian baru dari selisih hitungan harian alat. Hitungan sama / turun (hari baru, alat restart) bukan kejadian;
 * laporan pertama (belum ada pembanding) hanya menjadi dasar.
 * @param {Map<string, number>} lama kunci data (mis. 'dosing_ab_hari') → hitungan terakhir yang diketahui
 * @param {Record<string, unknown>} mentah payload data alat
 * @returns {{jenis: string, total_hari: number}[]}
 */
function kejadianBaru(lama, mentah) {
  const hasil = [];
  for (const [kunci, jenis] of Object.entries(JENIS_DOSING)) {
    const v = mentah?.[kunci];
    if (v == null || v === '' || !Number.isFinite(Number(v))) continue;
    const baru = Math.round(Number(v));
    const sebelum = lama.get(kunci);
    if (sebelum == null || baru <= sebelum) continue;
    for (let n = sebelum + 1; n <= Math.min(baru, sebelum + MAKS_PER_LAPORAN); n += 1) hasil.push({ jenis, total_hari: n });
  }
  return hasil;
}

/** Catat kejadian dosing dari satu laporan data alat. Dipanggil SEBELUM hitungan terbaru disimpan ke aktuator_state. */
async function catatKejadianDosing(kode, mentah) {
  const kunci = Object.keys(JENIS_DOSING).filter((k) => mentah?.[k] != null);
  if (!kunci.length) return;
  const baris = await q('SELECT kunci, nilai FROM aktuator_state WHERE kunci = ANY($1::text[])', [kunci.map((k) => `v6_${k}`)]);
  const lama = new Map(baris.map((r) => [r.kunci.slice(3), Number(r.nilai)]));
  const kejadian = kejadianBaru(lama, mentah);
  if (!kejadian.length) return;
  const meja = (await one('SELECT id_meja FROM perangkat WHERE kode = $1', [kode]))?.id_meja ?? null;
  for (const k of kejadian) {
    await q('INSERT INTO dosing_kejadian (perangkat_kode, id_meja, jenis, total_hari) VALUES ($1, $2, $3, $4)', [kode, meja, k.jenis, k.total_hari]);
  }
}

/**
 * Target kurva batch untuk `maju` hari ke depan, mulai besok 00.00 (waktu server), didahului titik "sekarang".
 * Per hari: naik sesuai kurva. Per siklus: tetap — ppm tahap berikutnya baru berlaku setelah petani mengonfirmasi pindah tahap.
 * @returns {{t: number, ppm: number}[]}
 */
function rencanaTarget(batch, maju, sekarang = Date.now()) {
  if (!batch) return [];
  const sekarangPpm = P.targetBatch(batch)?.ppm;
  const hasil = sekarangPpm == null ? [] : [{ t: sekarang, ppm: sekarangPpm }];
  const h0 = P.hariSemai(batch);
  const netpot = Number(batch.hari_netpot);
  const tengahMalam = new Date(sekarang);
  tengahMalam.setHours(0, 0, 0, 0);
  for (let d = 1; d <= maju; d += 1) {
    const ppm = P.targetBatch({
      ...batch,
      ...(h0 == null ? {} : { hari_semai: h0 + d }),
      ...(Number.isFinite(netpot) ? { hari_netpot: netpot + d } : {}),
    })?.ppm;
    if (ppm != null) hasil.push({ t: tengahMalam.getTime() + d * 86_400_000, ppm });
  }
  return hasil;
}

const bulatHari = (v) => Math.min(14, Math.max(1, Math.round(Number(v)) || 7));

/** Bentuk jawaban kosong (mode demo / belum ada batch): halaman menampilkan penjelasan, bukan galat. */
function kosong(hari = 7, sekarang = Date.now()) {
  return {
    batch: null, alat: null, dari: sekarang - hari * 86_400_000, sampai: sekarang, sekarang,
    aktual: [], target_alat: [], rencana: [], dosing: [],
    hari_ini: { target_batch: null, target_alat: null, ppm_aktual: null, ppm_segar: false, dosing: { AB: 0, PH: 0, ENCER: 0 } },
  };
}

/**
 * @param {{hari?: number|string, maju?: number|null, idMeja?: string|number|null}} opsi
 */
async function dataNutrisi({ hari = 7, maju = null, idMeja = null } = {}) {
  const h = bulatHari(hari);
  // rencana ke depan proporsional: rentang 24 jam → 1 hari ke depan (supaya riwayat tidak terjepit), selainnya 2 hari
  if (maju == null) maju = h <= 1 ? 1 : 2;
  const sekarang = Date.now();
  const mejaId = idMeja ?? (await S.mejaBatchTerbaru());
  const batchMap = await P.batchPerMeja();
  const batch = mejaId == null ? null : batchMap.get(String(mejaId)) ?? null;
  const alat = mejaId == null ? null : await S.alatMeja(mejaId);
  const dasar = kosong(h, sekarang);

  const [aktual, terakhir] = await Promise.all([
    q(`SELECT date_trunc('hour', created_at) AS t, round(avg(tds)::numeric)::int AS ppm
         FROM monitorings
        WHERE created_at >= now() - make_interval(days => $1) AND tds IS NOT NULL
          AND ($2::bigint IS NULL OR id_meja = $2 OR id_meja IS NULL)
        GROUP BY 1 ORDER BY 1`, [h, mejaId]),
    one(`SELECT tds, coalesce(updated_at, created_at) AS t FROM monitorings WHERE tds IS NOT NULL
          AND ($1::bigint IS NULL OR id_meja = $1 OR id_meja IS NULL) ORDER BY created_at DESC, id DESC LIMIT 1`, [mejaId]),
  ]);

  let targetAlat = [];
  if (alat) {
    const sebelum = await one(
      `SELECT coalesce(selesai_pada, dibuat_pada) AS t, (parameter->>'target_ppm')::numeric AS ppm FROM perintah_aktuator
        WHERE perangkat_kode = $1 AND tipe IN ('SEMAI', 'TARGET') AND status = 'selesai' AND parameter ? 'target_ppm'
          AND coalesce(selesai_pada, dibuat_pada) < now() - make_interval(days => $2)
        ORDER BY coalesce(selesai_pada, dibuat_pada) DESC LIMIT 1`, [alat.kode, h]);
    const dalam = await q(
      `SELECT coalesce(selesai_pada, dibuat_pada) AS t, (parameter->>'target_ppm')::numeric AS ppm FROM perintah_aktuator
        WHERE perangkat_kode = $1 AND tipe IN ('SEMAI', 'TARGET') AND status = 'selesai' AND parameter ? 'target_ppm'
          AND coalesce(selesai_pada, dibuat_pada) >= now() - make_interval(days => $2)
        ORDER BY coalesce(selesai_pada, dibuat_pada)`, [alat.kode, h]);
    // titik sebelum jendela dipindah ke awal jendela supaya garis bertangga tidak mulai dari kosong
    targetAlat = [...(sebelum ? [{ t: dasar.dari, ppm: Number(sebelum.ppm) }] : []), ...dalam.map((r) => ({ t: new Date(r.t).getTime(), ppm: Number(r.ppm) }))];
  }

  const dosing = (await q(
    `SELECT jenis, terjadi_pada AS t FROM dosing_kejadian
      WHERE jenis <> 'ISI' AND terjadi_pada >= now() - make_interval(days => $1) AND ($2::bigint IS NULL OR id_meja = $2 OR id_meja IS NULL)
      ORDER BY terjadi_pada`, [h, mejaId])).map((r) => ({ t: new Date(r.t).getTime(), jenis: r.jenis }));

  const { keadaanAlat: a } = await bacaKeadaanAlat(null);
  const umurTerakhir = terakhir ? (sekarang - new Date(terakhir.t).getTime()) / 1000 : null;
  return {
    ...dasar,
    batch: batch && {
      id_meja: batch.id_meja, tanaman: batch.nama_tanaman ?? null, tahap: batch.tahap, hari_semai: P.hariSemai(batch),
      cara: batch.kurva_cara ?? null,
    },
    alat,
    sampai: sekarang + maju * 86_400_000,
    aktual: aktual.map((r) => ({ t: new Date(r.t).getTime(), ppm: Number(r.ppm) })),
    target_alat: targetAlat,
    rencana: rencanaTarget(batch, maju, sekarang),
    dosing,
    hari_ini: {
      target_batch: batch ? P.targetBatch(batch)?.ppm ?? null : null,
      target_alat: a.target_ppm,
      ppm_aktual: terakhir ? Number(terakhir.tds) : null,
      ppm_segar: umurTerakhir != null && umurTerakhir <= 300,
      dosing: { AB: a.dosing_ab_hari ?? 0, PH: a.dosing_ph_hari ?? 0, ENCER: a.encer_hari ?? 0 },
    },
  };
}

module.exports = { kejadianBaru, catatKejadianDosing, rencanaTarget, dataNutrisi, kosong, JENIS_DOSING };
