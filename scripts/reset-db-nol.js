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

    // 4. Reset parameter v4.1 ke kondisi awal bersih (volume 0 L, hitungan harian 0, saklar ON, pemeliharaan OFF)
    //    sekaligus mengisi 11 parameter keselamatan P1 yang sebelumnya masih NULL.
    const setDosis = [
      ['volume_efektif_l', 0, 'L', 'Volume efektif penampung (0 L = belum diisi petani)'],
      ['jumlah_talang', 5, 'talang', 'Jumlah talang meja hidroponik'],
      ['debit_per_talang_lpm', 1.0, 'L/menit', 'Debit aliran per talang'],
      ['persen_ronde_dosis', 65, '%', 'Persen pemberian per siklus dosing (v4.1)'],
      ['maks_ppm_per_suntikan', 300, 'ppm', 'Batas kenaikan maksimum per siklus dosing (v4.1)'],
      ['batas_ec_bawah_ppm', 900, 'ppm', 'Batas aman EC bawah (v4.1)'],
      ['batas_ec_atas_ppm', 1500, 'ppm', 'Batas aman EC atas (v4.1)'],
      ['batas_ph_bawah', 5.0, 'pH', 'Batas aman pH bawah (v4.1)'],
      ['batas_ph_atas', 7.0, 'pH', 'Batas aman pH atas (v4.1)'],
      ['ph_maks_ml', 0, 'mL', 'Batas mL per koreksi pH (0 = otomatis 0,2 x volume)'],
      ['saklar_ab', 1, 'bool', 'Saklar izin Dosing A + B (1=nyala, 0=mati)'],
      ['saklar_ph_up', 1, 'bool', 'Saklar izin koreksi pH up (1=nyala, 0=mati)'],
      ['saklar_ph_down', 1, 'bool', 'Saklar izin koreksi pH down (1=nyala, 0=mati)'],
      ['saklar_pengenceran', 1, 'bool', 'Saklar izin pengenceran otomatis (1=nyala, 0=mati)'],
      ['mode_isi_otomatis', 1, 'bool', 'Mode pengisian air otomatis (1=otomatis, 0=manual)'],
      ['mode_pemeliharaan_v41', 0, 'bool', 'Status mode pemeliharaan v4.1'],
      ['hit_ec_hari_v41', 0, 'kali', 'Hitungan dosing EC harian v4.1'],
      ['vol_ph_hari_v41', 0, 'mL', 'Total volume koreksi pH harian v4.1'],
      ['maks_masa_persetujuan_menit', 30, 'menit', 'Batas waktu persetujuan dosing manual/semi-otomatis'],
      ['min_progres_persen', 10, '%', 'Progres minimum perubahan EC/pH pasca suntikan'],
      ['maks_lampau_persen', 15, '%', 'Batas overshoot maksimum di atas target'],
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
