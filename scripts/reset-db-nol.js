#!/usr/bin/env node
'use strict';
/**
 * Reset database ke kondisi bersih (0 data operasional/riwayat/kebun/sensor/audit)
 * KECUALI tabel `users` (hanya menyisakan 3 akun resmi: garap, demo, petani)
 * serta mereset kamus parameter sistem & mengisi parameter keselamatan yang sebelumnya NULL.
 */
const { pool } = require('../src/db');

const TABEL_KOSONGKAN = [
  'notifikasi_baca',
  'notifikasi',
  'anomali_tindakan',
  'anomali',
  'dosing_transisi',
  'dosing_rounds',
  'perintah_aktuator',
  'dosing_events',
  'persetujuan_dosing',
  'rekomendasi_dosing',
  'permintaan_konfirmasi',
  'siklus_transisi',
  'siklus_lot',
  'penampung_states',
  'siklus_budidaya',
  'panens',
  'pendewasaans',
  'peremajaans',
  'semais',
  'sikluses',
  'penugasan_penampung',
  'pemetaan_katup',
  'sensor_overrides',
  'sensor_readings_hourly',
  'sensor_readings_latest',
  'sensor_readings',
  'monitorings',
  'alert_logs',
  'audit_logs',
  'kalibrasi_log',
  'report_logs',
  'water_fill_events',
  'wa_settings',
  'jadwal_perawatan',
  'cctv_kameras',
  'Preset_Nutrisi_Skip', // placeholder
  'preset_versi',
  'preset_nutrisi',
  'tanamen',
  'mejas',
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Kosongkan seluruh tabel data/riwayat/operasional/master kebun
    for (const t of TABEL_KOSONGKAN) {
      if (t === 'Preset_Nutrisi_Skip') continue;
      await client.query(`DELETE FROM "${t}"`);
    }

    // 2. Bersihkan akun uji dari tabel users, pertahankan hanya akun resmi (garap, demo, petani)
    await client.query(`DELETE FROM users WHERE username NOT IN ('garap', 'demo', 'petani')`);

    // 3. Reset status perangkat, aktuator, water control, dan kalibrasi sensor ke kondisi awal (nol/belum pernah)
    await client.query(`UPDATE water_controls SET command = 'AUTO', mode = 'AUTO', valve_state = 'OFF', updated_at = CURRENT_TIMESTAMP`);
    await client.query(`UPDATE aktuator_state SET nilai = '0', diubah_pada = CURRENT_TIMESTAMP WHERE kunci = 'estop'`);
    await client.query(`UPDATE perangkat SET terakhir_terlihat = NULL, rssi = NULL, uptime_detik = NULL, estop_aktif = false, ip_terakhir = NULL`);
    await client.query(`UPDATE kalibrasi_sensor SET terakhir_dikalibrasi = NULL, hasil_ukur = NULL`);

    // 4. Reset parameter v4.1 ke kondisi awal bersih & aman (volume NULL = belum diukur, saklar OFF = 0)
    //    serta menerapkan keputusan pemilik 7 Nov 2026 (A1–A4).
    const setDosis = [
      ['volume_efektif_l', null, 'L', 'Volume efektif penampung (NULL = belum diukur fisik di lapangan)'],
      ['jumlah_talang', 5, 'talang', 'Jumlah talang meja hidroponik'],
      ['debit_per_talang_lpm', 1.0, 'L/menit', 'Debit aliran per talang'],
      ['persen_ronde_dosis', 35, '%', 'Persen pemberian proporsional per siklus dosing (v4.1)'],
      ['maks_ppm_per_suntikan', 300, 'ppm', 'Batas kenaikan maksimum per siklus dosing (v4.1)'],
      ['batas_ec_bawah_ppm', 400, 'ppm', 'Batas aman EC bawah Melon (keputusan 7 Nov: 400 ppm)'],
      ['batas_ec_atas_ppm', 2000, 'ppm', 'Batas kunci EC atas Melon (keputusan 7 Nov: kunci > 2000 ppm)'],
      ['batas_ph_bawah', 5.5, 'pH', 'Batas aman pH bawah Melon (keputusan 7 Nov: 5.5)'],
      ['batas_ph_atas', 6.5, 'pH', 'Batas aman pH atas Melon (keputusan 7 Nov: 6.5)'],
      ['ph_maks_ml', 0, 'mL', 'Batas mL per koreksi pH (0 = otomatis 0,2 x volume)'],
      ['laju_pompa_a_mls', null, 'mL/detik', 'Laju pompa A hasil gelas ukur (NULL = belum dikalibrasi)'],
      ['laju_pompa_b_mls', null, 'mL/detik', 'Laju pompa B hasil gelas ukur (NULL = belum dikalibrasi)'],
      ['laju_pompa_ph_up_mls', null, 'mL/detik', 'Laju pompa pH Up hasil gelas ukur (NULL = belum dikalibrasi)'],
      ['laju_pompa_ph_down_mls', null, 'mL/detik', 'Laju pompa pH Down hasil gelas ukur (NULL = belum dikalibrasi)'],
      ['saklar_ab', 0, 'bool', 'Saklar izin Dosing A + B (bawaan aman: 0=mati)'],
      ['saklar_ph_up', 0, 'bool', 'Saklar izin koreksi pH up (bawaan aman: 0=mati)'],
      ['saklar_ph_down', 0, 'bool', 'Saklar izin koreksi pH down (bawaan aman: 0=mati)'],
      ['saklar_pengenceran', 0, 'bool', 'Saklar izin pengenceran otomatis (bawaan aman: 0=mati)'],
      ['mode_isi_otomatis', 0, 'bool', 'Mode pengisian air otomatis (bawaan aman: 0=manual/mati)'],
      ['mode_pemeliharaan_v41', 0, 'bool', 'Status mode pemeliharaan v4.1'],
      ['hit_ec_hari_v41', 0, 'kali', 'Hitungan dosing EC harian v4.1'],
      ['vol_ph_hari_v41', 0, 'mL', 'Total volume koreksi pH harian v4.1'],
      ['maks_ml_per_suntikan', 214, 'mL', 'Batas volume mL per satu kali suntikan nutrisi A/B'],
      ['maks_volume_ab_hari_ml', 500, 'mL', 'Batas kuota harian total nutrisi A+B (mL/hari)'],
      ['maks_ml_ph_per_suntikan', 10, 'mL', 'Batas volume mL per satu kali suntikan pH Up/Down'],
      ['maks_volume_ph_hari_ml', 50, 'mL', 'Batas kuota harian total larutan pH (mL/hari)'],
      ['maks_masa_persetujuan_menit', 30, 'menit', 'Batas waktu persetujuan dosing manual/semi-otomatis (keputusan 7 Nov)'],
      ['min_progres_persen', 10, '%', 'Progres minimum perubahan EC/pH pasca suntikan (keputusan 7 Nov)'],
      ['maks_lampau_persen', 15, '%', 'Batas overshoot maksimum di atas target (keputusan 7 Nov)'],
      ['stabil_toleransi_ph', 0.06, 'pH', 'Batas sebaran maksimum 5 bacaan pH dianggap stabil (v4.1)'],
      ['stabil_toleransi_tds_ppm', 20, 'ppm', 'Batas sebaran maksimum 5 bacaan EC/TDS dianggap stabil (v4.1)'],
    ];
    for (const [param, nilai, satuan, ket] of setDosis) {
      await client.query(
        `INSERT INTO konfigurasi_dosis (param, nilai, satuan, keterangan, sumber, diubah_pada)
         VALUES ($1, $2, $3, $4, 'Reset Awal v4.1', CURRENT_TIMESTAMP)
         ON CONFLICT (param) DO UPDATE
           SET nilai = EXCLUDED.nilai, diubah_pada = CURRENT_TIMESTAMP`,
        [param, nilai, satuan, ket],
      );
    }

    const setTiming = [
      ['monitoring_menit', 45, 'menit', 'Jeda monitoring rutin sebelum alat menilai EC & pH (v4.1)'],
      ['jeda_ab_menit', 5, 'menit', 'Jeda wajib antara Pompa A dan Pompa B (v4.1)'],
      ['jeda_ec_menit', 20, 'menit', 'Jeda tenang antara koreksi EC dan evaluasi pH (v4.1)'],
      ['pemeliharaan_maks_menit', 120, 'menit', 'Batas waktu mode pemeliharaan otomatis kembali normal (v4.1)'],
      ['limit_batas_ons_pompa', 180, 'detik', 'Batas nyala maksimum pompa per satu kali perintah'],
      ['stabil_menit', 5, 'menit', 'Jendela waktu penilaian kestabilan bacaan sensor'],
      ['stabil_n_bacaan', 5, 'bacaan', 'Jumlah bacaan berurutan untuk uji kestabilan (v4.1: 5 bacaan)'],
      ['konfirmasi_tandon_jam', 24, 'jam', 'Interval pemeriksaan ketersediaan larutan stok tandon'],
      ['ulang_konfirmasi_jam', 4, 'jam', 'Jeda pengulangan pengingat konfirmasi tandon'],
      ['pengingat_konfirmasi_jam', 1, 'jam', 'Jeda notifikasi pengingat sebelum batas waktu habis'],
    ];
    for (const [param, nilai, satuan, ket] of setTiming) {
      await client.query(
        `INSERT INTO timing_operasi (param, nilai, satuan, keterangan, sumber, diubah_pada)
         VALUES ($1, $2, $3, $4, 'Reset Awal v4.1', CURRENT_TIMESTAMP)
         ON CONFLICT (param) DO UPDATE
           SET nilai = EXCLUDED.nilai, diubah_pada = CURRENT_TIMESTAMP`,
        [param, nilai, satuan, ket],
      );
    }

    await client.query('COMMIT');
    console.log('✅ Database berhasil di-reset ke nol (kecuali akun users: garap, demo, petani).');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Gagal mereset database:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
