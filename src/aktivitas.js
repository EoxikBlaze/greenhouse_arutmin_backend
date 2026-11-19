'use strict';
/**
 * Catatan Aktivitas — satu linimasa dari semua sumber (GET /aktivitas):
 *   data / pengaturan / login  audit_logs        (perubahan lewat web)
 *   perintah                   perintah_aktuator (perintah ke alat + jawaban alat)
 *   peringatan                 alert_logs        (kejadian dibuka dan selesai)
 *   dosing                     dosing_kejadian   (dosing/isi air/pengenceran yang dilakukan alat)
 *   kalibrasi                  kalibrasi_log     (kalibrasi, uji lab, tes pompa)
 * Filter jenis/tanggal/kata dikirim sebagai parameter ($n), tidak pernah disambung ke SQL.
 */
const { q } = require('./db');

const JENIS = ['data', 'pengaturan', 'login', 'perintah', 'peringatan', 'dosing', 'kalibrasi'];
const MAKS_CSV = 5000;

/** Satu CTE gabungan; $1 = dari, $2 = sampai (eksklusif). Kolom waktu tiap cabang berindeks. */
const SUMBER = `
  WITH s AS (
    SELECT 'audit:' || a.id AS kunci, a.terjadi_pada AS waktu,
           CASE WHEN a.aksi = 'login' THEN 'login' WHEN a.aksi = 'config_change' THEN 'pengaturan' ELSE 'data' END AS jenis,
           a.aksi AS aksi, coalesce(a.actor_label, '-') AS pelaku, a.tabel AS objek, a.row_id::text AS ref,
           NULL::text AS status, NULL::text AS ringkas,
           jsonb_build_object('sebelum', a.before_data, 'sesudah', a.after_data, 'meta', a.meta, 'ip', a.ip) AS detail
      FROM audit_logs a WHERE a.terjadi_pada >= $1 AND a.terjadi_pada < $2
    UNION ALL
    SELECT 'perintah:' || p.id, p.dibuat_pada, 'perintah', p.tipe, coalesce(u.username, p.sumber, '-'), p.perangkat_kode, p.id::text,
           p.status, coalesce(p.hasil->>'alasan', p.alasan),
           jsonb_build_object('parameter', p.parameter, 'hasil', p.hasil, 'alasan', p.alasan, 'sumber', p.sumber,
                              'dikirim_pada', p.dikirim_pada, 'selesai_pada', p.selesai_pada)
      FROM perintah_aktuator p LEFT JOIN users u ON u.id = p.dibuat_oleh WHERE p.dibuat_pada >= $1 AND p.dibuat_pada < $2
    UNION ALL
    SELECT 'peringatan:' || l.id || ':buka', l.created_at, 'peringatan', 'buka', 'alat', l.type, l.id_meja::text,
           l.severity, l.value, jsonb_build_object('severity', l.severity, 'meja', l.id_meja, 'ditandai', l.acknowledged)
      FROM alert_logs l WHERE l.created_at >= $1 AND l.created_at < $2
    UNION ALL
    SELECT 'peringatan:' || l.id || ':selesai', l.selesai_pada, 'peringatan', 'selesai', 'alat', l.type, l.id_meja::text,
           l.severity, l.value, jsonb_build_object('severity', l.severity, 'meja', l.id_meja, 'mulai', l.created_at)
      FROM alert_logs l WHERE l.selesai_pada IS NOT NULL AND l.selesai_pada >= $1 AND l.selesai_pada < $2
    UNION ALL
    SELECT 'dosing:' || d.id, d.terjadi_pada, 'dosing', d.jenis, 'alat', d.perangkat_kode, d.id_meja::text,
           NULL, 'ke-' || d.total_hari || ' hari ini', jsonb_build_object('total_hari', d.total_hari, 'meja', d.id_meja)
      FROM dosing_kejadian d WHERE d.terjadi_pada >= $1 AND d.terjadi_pada < $2
    UNION ALL
    SELECT 'kalibrasi:' || k.id, k.dilakukan_pada, 'kalibrasi', k.sensor, coalesce(k.oleh_label, '-'), k.sensor, NULL,
           CASE WHEN k.lulus IS FALSE THEN 'gagal' ELSE 'lulus' END, k.catatan,
           jsonb_build_object('nilai_ref', k.nilai_ref, 'sebelum', k.bacaan_sebelum, 'sesudah', k.bacaan_sesudah,
                              'konstanta_lama', k.konstanta_lama, 'konstanta_baru', k.konstanta_baru)
      FROM kalibrasi_log k WHERE k.dilakukan_pada >= $1 AND k.dilakukan_pada < $2
  )`;

/** Batas atas = akhir hari `sampai` (bawaan hari ini); awal = `dari` (bawaan 30 hari sebelum batas atas). Waktu UTC. */
function rentang({ dari, sampai }, sekarang = new Date()) {
  const akhir = sampai ? new Date(`${sampai}T00:00:00Z`) : new Date(sekarang.getTime() - (sekarang.getTime() % 86_400_000));
  const batasAtas = new Date(akhir.getTime() + 86_400_000);
  const awal = dari ? new Date(`${dari}T00:00:00Z`) : new Date(batasAtas.getTime() - 30 * 86_400_000);
  return { awal: awal.toISOString(), akhir: batasAtas.toISOString() };
}

const kataLike = (kata) => (kata ? `%${kata.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : '');
const SARING = `($3 = '' OR jenis = $3) AND ($4 = '' OR pelaku ILIKE $4 OR objek ILIKE $4 OR aksi ILIKE $4 OR ringkas ILIKE $4)`;

/**
 * @param {{jenis?: string, dari?: string, sampai?: string, kata?: string, page?: number, perPage?: number}} opsi
 */
async function cari({ jenis = '', dari, sampai, kata = '', page = 1, perPage = 20 } = {}, sekarang = new Date()) {
  const { awal, akhir } = rentang({ dari, sampai }, sekarang);
  const arg = [awal, akhir, jenis, kataLike(kata)];
  const [baris, total, perJenis] = await Promise.all([
    q(`${SUMBER} SELECT * FROM s WHERE ${SARING} ORDER BY waktu DESC, kunci DESC LIMIT $5 OFFSET $6`, [...arg, perPage, (page - 1) * perPage]),
    q(`${SUMBER} SELECT count(*)::int AS n FROM s WHERE ${SARING}`, arg),
    q(`${SUMBER} SELECT jenis, count(*)::int AS n FROM s WHERE ($3::text IS NOT NULL) AND ($4 = '' OR pelaku ILIKE $4 OR objek ILIKE $4 OR aksi ILIKE $4 OR ringkas ILIKE $4) GROUP BY jenis`, arg),
  ]);
  return { data: baris, total: total[0]?.n ?? 0, per_jenis: Object.fromEntries(perJenis.map((r) => [r.jenis, r.n])), dari: awal, sampai: akhir };
}

/** Baris untuk CSV (tanpa halaman), maksimal MAKS_CSV. */
async function untukCsv({ jenis = '', dari, sampai, kata = '' } = {}, sekarang = new Date()) {
  const { awal, akhir } = rentang({ dari, sampai }, sekarang);
  return q(`${SUMBER} SELECT * FROM s WHERE ${SARING} ORDER BY waktu DESC, kunci DESC LIMIT ${MAKS_CSV}`, [awal, akhir, jenis, kataLike(kata)]);
}

module.exports = { JENIS, MAKS_CSV, rentang, cari, untukCsv };
