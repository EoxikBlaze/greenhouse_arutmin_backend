'use strict';
/** Logbook kebun untuk Asisten AI: kegiatan 7 hari terakhir dari data aplikasi (tanpa LLM, tanpa data karangan). */
const { q } = require('./db');

const SQL = `
  SELECT waktu, teks FROM (
    SELECT tgl_awal_semai::timestamp AS waktu, 'Semai dimulai (' || jumlah_benih || ' benih)' AS teks FROM semais
    UNION ALL SELECT tgl_awal_peremajaan::timestamp, 'Peremajaan dimulai (' || jumlah_masuk || ' tanaman)' FROM peremajaans
    UNION ALL SELECT tgl_awal_pendewasaan::timestamp, 'Pendewasaan dimulai (' || jumlah_masuk || ' tanaman)' FROM pendewasaans
    UNION ALL SELECT tgl_panen::timestamp, 'Panen dicatat (' || panen_berhasil || ' tanaman)' FROM panens
    UNION ALL SELECT terjadi_pada, 'Saklar ' || row_id || ' diubah' FROM audit_logs WHERE tabel = 'saklar_aktuator'
    UNION ALL SELECT mulai_pada, coalesce(alasan, 'Dosing manual') || ' — ' || hasil FROM dosing_events WHERE pemicu = 'USER_MANUAL'
    UNION ALL SELECT tanggal::timestamp, 'Uji lab ' || kategori || ': ' || parameter || ' = ' || nilai::float8 FROM uji_lab
    UNION ALL SELECT dilakukan_pada, 'Kalibrasi ' || sensor FROM kalibrasi_log WHERE catatan NOT LIKE '[%'
  ) k
  WHERE waktu >= now() - interval '7 days' ORDER BY waktu DESC LIMIT 25`;

const tgl = (d) => new Date(d).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'Asia/Makassar' });

async function logbookKebun() {
  const rows = await q(SQL, []);
  if (!rows.length) return 'Logbook 7 hari terakhir: belum ada kegiatan tercatat (semai, panen, saklar, dosing manual, uji lab, kalibrasi).';
  return ['Logbook kebun 7 hari terakhir (dari data aplikasi):', ...rows.map((r) => `• ${tgl(r.waktu)} — ${r.teks}`)].join('\n');
}

module.exports = { logbookKebun };
