'use strict';
/**
 * Suite Integrasi End-to-End: Alur Langkah Petani & Debugging Tombol demi Tombol (v4.1)
 *
 * Menguji seluruh urutan kerja petani dari instalasi alat awal hingga panen/kuras air:
 *  Langkah 1 — Pengaturan Alat (/pengaturan-alat): volume, talang, debit, T_putar, waktu kerja, batas aman
 *  Langkah 2 — Mode Pemeliharaan & Kalibrasi (/kalibrasi): EC 2-titik + balik, pH 2-titik + balik, 4 pompa
 *  Langkah 3 — Uji Lab Larutan (/ujilab): Uji Lab EC (ppm/mL), Uji Lab pH Up & pH Down (mL/pH/L)
 *  Langkah 4 — Saklar & Mode (/saklar): 4 saklar tindakan + mode isi air (otomatis/manual)
 *  Langkah 5 — Tanam & Pratinjau Dosis (/tanam & /dosing): hitungPratinjauDosis 65% dari kekurangan
 *  Langkah 6 — Dosing Manual (/dosing-manual): Dosing A+B, Koreksi pH Up/Down, STOP darurat, blokir saat saklar OFF/pemeliharaan ON
 *  Langkah 7 — Kuras dihapus; toggle pemeliharaan tetap ada (dipakai halaman Kalibrasi)
 *  Langkah 8 — Peringatan, Pemulihan Papan & MQTT Diagnostik (/peringatan, /pemulihan-papan, /mqtt-diagnostik)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, craftToken, bearer } = require('./_server');
const { lewati } = require('./_isolasi');
const { q } = require('../../src/db');

let srv;
let tokAdmin;
let stateAwal;

before(async () => {
  if (lewati) return;
  srv = await startServer();
  tokAdmin = craftToken({ sub: 1, username: 'garap', level: 'admin', demo: false }, { expiresIn: '1h' });
  const r = await request(srv.base).get('/iot-v41/state').set(bearer(tokAdmin));
  assert.equal(r.status, 200);
  stateAwal = r.body;
});

after(async () => {
  if (lewati) return;
  if (srv && stateAwal?.params) {
    // Kembalikan state ke kondisi aman (saklar MATI, mode isi manual, pemeliharaan OFF)
    await request(srv.base)
      .put('/iot-v41/pengaturan')
      .set(bearer(tokAdmin))
      .send({
        volume_l: 200,
        talang_jumlah: 5,
        talang_debit: 1.0,
        monitoring_menit: 80,
        jeda_ab_menit: 5,
        jeda_ec_menit: 20,
        persen_dosing: 65,
        max_ppm_dosing: 300,
        batas_ec_bawah: 900,
        batas_ec_atas: 1500,
        batas_ph_bawah: 5.0,
        batas_ph_atas: 7.0,
        ph_maks_ml: 0,
        pemeliharaan_maks_menit: 120,
      });
    await request(srv.base)
      .put('/iot-v41/saklar')
      .set(bearer(tokAdmin))
      .send({
        saklar_ab: 0,
        saklar_ph_up: 0,
        saklar_ph_down: 0,
        saklar_pengenceran: 0,
        mode_isi: 'manual',
      });
    await q("UPDATE penampung_states SET mode_pemeliharaan = false, status_lock = false, lock_alasan = NULL, kejadian_dosis_hari = 0, volume_ab_hari_ml = 0, volume_ph_hari_ml = 0");
  }
  if (srv) await srv.stop();
});

test('Langkah 1 — Pengaturan Alat: Tombol [Simpan & kirim ke alat] menghitung T_putar & menolak batas terbalik', { skip: lewati }, async () => {
  // 1a. Uji validasi batas EC bawah > batas atas ditolak 422
  const gagal = await request(srv.base)
    .put('/iot-v41/pengaturan')
    .set(bearer(tokAdmin))
    .send({
      volume_l: 200,
      talang_jumlah: 5,
      talang_debit: 1.0,
      monitoring_menit: 80,
      jeda_ab_menit: 5,
      jeda_ec_menit: 20,
      persen_dosing: 65,
      max_ppm_dosing: 300,
      batas_ec_bawah: 1600,
      batas_ec_atas: 1200,
      batas_ph_bawah: 5.0,
      batas_ph_atas: 7.0,
      ph_maks_ml: 0,
      pemeliharaan_maks_menit: 120,
    });
  assert.equal(gagal.status, 422);
  assert.ok(gagal.body.errors.batas_ec_bawah);

  // 1b. Klik [Simpan & kirim ke alat] dengan volume 200 L, 5 talang, debit 1,0 L/menit -> T_putar = 40 mnt, saran monitoring = 80 mnt
  const ok = await request(srv.base)
    .put('/iot-v41/pengaturan')
    .set(bearer(tokAdmin))
    .send({
      volume_l: 200,
      talang_jumlah: 5,
      talang_debit: 1.0,
      monitoring_menit: 80,
      jeda_ab_menit: 5,
      jeda_ec_menit: 20,
      persen_dosing: 65,
      max_ppm_dosing: 300,
      batas_ec_bawah: 900,
      batas_ec_atas: 1500,
      batas_ph_bawah: 5.5,
      batas_ph_atas: 6.5,
      ph_maks_ml: 0,
      pemeliharaan_maks_menit: 120,
    });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, true);
  assert.equal(ok.body.data.volume_l, 200);
  assert.equal(ok.body.data.putaran_menit, 40);
  assert.equal(ok.body.data.saran_monitoring_menit, 80);
  assert.equal(ok.body.data.batas_ml_ph_efektif, 40); // 0,2 * 200 L = 40 mL
});

test('Langkah 2 — Mode Pemeliharaan & Kalibrasi: Tombol [Aktifkan pemeliharaan], [Ambil titik EC/pH], [Balik kalibrasi], & [Simpan laju pompa]', { skip: lewati }, async () => {
  // 2a. Klik [Aktifkan pemeliharaan]
  const aktif = await request(srv.base)
    .post('/iot-v41/pemeliharaan')
    .set(bearer(tokAdmin))
    .send({ aksi: 'pemeliharaan', aktif: true });
  assert.equal(aktif.status, 200);
  assert.equal(aktif.body.pemeliharaan, true);

  // 2b. Klik [Ambil titik 1.413] + [Ambil titik 12.880] -> Simpan kalibrasi EC 2-titik
  const kalEc = await request(srv.base)
    .post('/iot-v41/kalibrasi-dua-titik')
    .set(bearer(tokAdmin))
    .send({ sensor: 'ec', titik_1: 1410, titik_2: 12860 });
  assert.equal(kalEc.status, 201);
  assert.equal(kalEc.body.status, true);
  assert.ok(kalEc.body.data.TDS_FAKTOR_KOREKSI > 0.99 && kalEc.body.data.TDS_FAKTOR_KOREKSI < 1.02);

  // 2c. Klik [Balik kalibrasi EC ke nilai sebelumnya]
  const balikEc = await request(srv.base)
    .post('/iot-v41/kalibrasi-dua-titik')
    .set(bearer(tokAdmin))
    .send({ sensor: 'ec', aksi: 'balik' });
  assert.equal(balikEc.status, 200);
  assert.equal(balikEc.body.status, true);

  // 2d. Klik [Ambil titik pH 4,0] + [Ambil titik pH 7,0] -> Simpan kalibrasi pH 2-titik
  const kalPh = await request(srv.base)
    .post('/iot-v41/kalibrasi-dua-titik')
    .set(bearer(tokAdmin))
    .send({ sensor: 'ph', titik_1: 4.02, titik_2: 7.01 });
  assert.equal(kalPh.status, 201);
  assert.equal(kalPh.body.status, true);
  assert.ok(kalPh.body.data.PH_SLOPE > 0.95 && kalPh.body.data.PH_SLOPE < 1.05);

  // 2e. Klik [Balik kalibrasi pH ke nilai sebelumnya]
  const balikPh = await request(srv.base)
    .post('/iot-v41/kalibrasi-dua-titik')
    .set(bearer(tokAdmin))
    .send({ sensor: 'ph', aksi: 'balik' });
  assert.equal(balikPh.status, 200);
  assert.equal(balikPh.body.status, true);

  // 2f. Klik [Simpan laju (mL ÷ detik)] untuk ke-4 pompa (A, B, pH up, pH down)
  const daftarPompa = [
    { pompa: 'a', detik: 60, ml: 60, lajuHarap: 1.0 },
    { pompa: 'b', detik: 30, ml: 63, lajuHarap: 2.1 },
    { pompa: 'ph_up', detik: 30, ml: 45, lajuHarap: 1.5 },
    { pompa: 'ph_down', detik: 30, ml: 46, lajuHarap: 1.53 },
  ];
  for (const p of daftarPompa) {
    const resPompa = await request(srv.base)
      .post('/iot-v41/kalibrasi-pompa')
      .set(bearer(tokAdmin))
      .send({ pompa: p.pompa, detik: p.detik, ml: p.ml });
    assert.equal(resPompa.status, 201);
    assert.equal(resPompa.body.data.laju, p.lajuHarap);
  }

  // 2g. Klik [Matikan pemeliharaan]
  const nonaktif = await request(srv.base)
    .post('/iot-v41/pemeliharaan')
    .set(bearer(tokAdmin))
    .send({ aksi: 'pemeliharaan', aktif: false });
  assert.equal(nonaktif.status, 200);
  assert.equal(nonaktif.body.pemeliharaan, false);
});

test('Langkah 3 — Uji Lab Larutan: Tombol [Hitung & simpan] untuk Uji Lab EC, pH up, dan pH down', { skip: lewati }, async () => {
  // 3a. Klik [Hitung & simpan] Uji Lab EC (Air 1 L, awal 100 ppm -> akhir 1000 ppm, A 5 mL + B 5 mL = 90 ppm/mL)
  const ecLab = await request(srv.base)
    .post('/iot-v41/ujilab')
    .set(bearer(tokAdmin))
    .send({ aksi: 'ec', awal: 100, akhir: 1000, volume: 1, ml_a: 5, ml_b: 5 });
  assert.equal(ecLab.status, 201);
  assert.equal(ecLab.body.data.ppm_per_ml, 90);

  // 3b. Klik [Hitung & simpan] Uji Lab pH up (Air 1 L, delta pH 0,5, larutan 0,5 mL = 1 mL/pH/L)
  const phUpLab = await request(srv.base)
    .post('/iot-v41/ujilab')
    .set(bearer(tokAdmin))
    .send({ aksi: 'ph', arah: 'up', volume: 1, delta_ph: 0.5, ml: 0.5 });
  assert.equal(phUpLab.status, 201);
  assert.equal(phUpLab.body.data.ml_per_ph_l, 1);

  // 3c. Klik [Hitung & simpan] Uji Lab pH down (Air 1 L, delta pH 0,5, larutan 0,6 mL = 1,2 mL/pH/L)
  const phDownLab = await request(srv.base)
    .post('/iot-v41/ujilab')
    .set(bearer(tokAdmin))
    .send({ aksi: 'ph', arah: 'down', volume: 1, delta_ph: 0.5, ml: 0.6 });
  assert.equal(phDownLab.status, 201);
  assert.equal(phDownLab.body.data.ml_per_ph_l, 1.2);

  // Kembalikan ppm_per_ml ke 100,7 sesuai setelan lapangan standar
  await request(srv.base)
    .post('/iot-v41/ujilab')
    .set(bearer(tokAdmin))
    .send({ aksi: 'ec', awal: 100, akhir: 1107, volume: 1, ml_a: 5, ml_b: 5 });
});

test('Langkah 4 — Saklar & Mode: Toggle saklar dan Tombol [Simpan & kirim ke alat]', { skip: lewati }, async () => {
  // 4a. Matikan saklar Dosing A+B dulu untuk menguji bahwa Dosing Manual menghormati saklar
  const matikanAb = await request(srv.base)
    .put('/iot-v41/saklar')
    .set(bearer(tokAdmin))
    .send({
      saklar_ab: 0,
      saklar_ph_up: 1,
      saklar_ph_down: 1,
      saklar_pengenceran: 1,
      mode_isi: 'manual',
    });
  assert.equal(matikanAb.status, 200);
  assert.equal(matikanAb.body.data.saklar_ab, 0);
  assert.equal(matikanAb.body.data.mode_isi, 'manual');

  // 4b. Dosing Manual A+B DIKUNCI (423) apa pun status saklarnya
  const tolakAb = await request(srv.base)
    .post('/iot-v41/dosing-manual')
    .set(bearer(tokAdmin))
    .send({ aksi: 'dosing_ab', ppm: 50 });
  assert.equal(tolakAb.status, 423);
  assert.equal(tolakAb.body.kode, 'eksekusi_diblokir');

  // 4c. Nyalakan kembali semua saklar & mode isi otomatis
  const nyalakanSemua = await request(srv.base)
    .put('/iot-v41/saklar')
    .set(bearer(tokAdmin))
    .send({
      saklar_ab: 1,
      saklar_ph_up: 1,
      saklar_ph_down: 1,
      saklar_pengenceran: 1,
      mode_isi: 'otomatis',
    });
  assert.equal(nyalakanSemua.status, 200);
  assert.equal(nyalakanSemua.body.data.saklar_ab, 1);
  assert.equal(nyalakanSemua.body.data.mode_isi, 'otomatis');
});

test('Langkah 6 — Dosing Manual: Tombol [Kirim dosing A + B], [Kirim koreksi pH], dan [STOP — matikan semua pompa]', { skip: lewati }, async () => {
  // Reset hitungan harian langsung di DB (halaman Kuras sudah dihapus) supaya mulai dari 0
  await q("UPDATE penampung_states SET mode_pemeliharaan = false, status_lock = false, lock_alasan = NULL, kejadian_dosis_hari = 0, volume_ab_hari_ml = 0, volume_ph_hari_ml = 0");

  const sebelum = (await request(srv.base).get('/iot-v41/state').set(bearer(tokAdmin))).body.kondisi;

  // 6a. Dosing A+B: dikunci, tidak ada hitungan yang berubah
  const dosAb = await request(srv.base)
    .post('/iot-v41/dosing-manual')
    .set(bearer(tokAdmin))
    .send({ aksi: 'dosing_ab', ppm: 50 });
  assert.equal(dosAb.status, 423);
  assert.equal(dosAb.body.kode, 'eksekusi_diblokir');
  assert.doesNotMatch(JSON.stringify(dosAb.body), /dikirim/);

  // 6b. Koreksi pH: dikunci
  const dosPh = await request(srv.base)
    .post('/iot-v41/dosing-manual')
    .set(bearer(tokAdmin))
    .send({ aksi: 'dosis_ph', arah: 'up', ml: 5 });
  assert.equal(dosPh.status, 423);

  // 6c. STOP: benar-benar diantre (202) dan TIDAK mengaku pompa sudah mati
  const stopRes = await request(srv.base)
    .post('/iot-v41/dosing-manual')
    .set(bearer(tokAdmin))
    .send({ aksi: 'stop' });
  assert.equal(stopRes.status, 202);
  assert.equal(stopRes.body.antre, true);
  assert.equal(stopRes.body.dikonfirmasi, false);
  assert.ok(stopRes.body.id_perintah, 'perintah STOP harus punya id');
  assert.doesNotMatch(stopRes.body.message, /dimatikan\.$/);
  const baris = await q('SELECT tipe, status FROM perintah_aktuator WHERE id = $1', [stopRes.body.id_perintah]);
  assert.equal(baris[0].tipe, 'STOP');

  // 6d. Tidak ada perintah DOSIS dan hitungan harian tidak berubah
  const dosis = await q("SELECT count(*)::int AS n FROM perintah_aktuator WHERE tipe = 'DOSIS'");
  assert.equal(dosis[0].n, 0);
  const sesudah = (await request(srv.base).get('/iot-v41/state').set(bearer(tokAdmin))).body.kondisi;
  assert.equal(sesudah.hit_ec, sebelum.hit_ec);
  assert.equal(sesudah.hit_ph, sebelum.hit_ph);

  // 6e. aksi tak dikenal → 422
  const aneh = await request(srv.base).post('/iot-v41/dosing-manual').set(bearer(tokAdmin)).send({ aksi: 'meledak' });
  assert.equal(aneh.status, 422);
});


test('Langkah 7 — Kuras dihapus: aksi kuras_mulai/air_diganti ditolak; toggle pemeliharaan (Kalibrasi) tetap jalan', { skip: lewati }, async () => {
  for (const aksi of ['kuras_mulai', 'air_diganti', 'selesai']) {
    const r = await request(srv.base).post('/iot-v41/pemeliharaan').set(bearer(tokAdmin)).send({ aksi });
    assert.equal(r.status, 422, aksi);
  }
  const on = await request(srv.base).post('/iot-v41/pemeliharaan').set(bearer(tokAdmin)).send({ aksi: 'pemeliharaan', aktif: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.pemeliharaan, true);
  const tolak = await request(srv.base).post('/iot-v41/dosing-manual').set(bearer(tokAdmin)).send({ aksi: 'dosing_ab', ppm: 50 });
  assert.equal(tolak.status, 423);
  const off = await request(srv.base).post('/iot-v41/pemeliharaan').set(bearer(tokAdmin)).send({ aksi: 'pemeliharaan', aktif: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.pemeliharaan, false);
});

test('Langkah 8 — Peringatan, Pemulihan Papan & MQTT Diagnostik: Tombol [Kirim RESET], [Kirim parameter + kalibrasi], & [Kirim ke broker]', { skip: lewati }, async () => {
  // 8a. Klik [Kirim RESET ke alat] di halaman Peringatan
  const resetRes = await request(srv.base)
    .post('/iot-v41/reset-peringatan')
    .set(bearer(tokAdmin))
    .send({});
  assert.equal(resetRes.status, 200);
  assert.equal(resetRes.body.status, true);
  assert.equal(resetRes.body.terkirim, false);
  assert.match(resetRes.body.message, /BELUM dikirim/);

  // 8b. Klik [Kirim parameter + kalibrasi ke alat] di halaman Pemulihan Papan
  const pulihRes = await request(srv.base)
    .post('/iot-v41/pulihkan')
    .set(bearer(tokAdmin))
    .send({});
  assert.equal(pulihRes.status, 200);
  assert.equal(pulihRes.body.status, true);
  assert.equal(pulihRes.body.data.cmd, 'pulihkan_kalibrasi');
  assert.equal(pulihRes.body.data.sumber, 'dipulihkan_dari_web');
  assert.equal(pulihRes.body.terkirim, false);
  assert.equal(pulihRes.body.data.terkirim, false);
  assert.match(pulihRes.body.message, /BELUM dikirim/);
  assert.equal(pulihRes.body.data.param.laju.length, 4);

  // 8c. Klik [Kirim ke broker] di halaman MQTT & Diagnostik
  const mqttRes = await request(srv.base)
    .post('/iot-v41/mqtt-uji')
    .set(bearer(tokAdmin))
    .send({ topic: 'garap/aktuator-01/perintah', pesan: '{"cmd":"status"}' });
  assert.equal(mqttRes.status, 200);
  assert.equal(mqttRes.body.status, true);
  assert.equal(mqttRes.body.terbit, false);
  assert.equal(mqttRes.body.topic, 'garap/aktuator-01/perintah');

  // satu kontrak: topik hidro/ dan topik liar ditolak
  for (const topic of ['hidro/HIDRO-01/cmd', 'garap/#', 'garap/a/b/c', '../x']) {
    const ditolak = await request(srv.base).post('/iot-v41/mqtt-uji').set(bearer(tokAdmin)).send({ topic, pesan: '{}' });
    assert.equal(ditolak.status, 422, topic);
  }
});

test('Keselamatan v4.1: saklar bawaan mati, parameter NULL tidak dibaca sebagai 0, petani/demo tidak bisa menulis', { skip: lewati }, async () => {
  // parameter kosong (NULL) = belum diputuskan: nilai cadangan, BUKAN 0
  await q("UPDATE konfigurasi_dosis SET nilai = NULL WHERE param = 'jumlah_talang'");
  const st = await request(srv.base).get('/iot-v41/state').set(bearer(tokAdmin));
  assert.equal(st.status, 200);
  assert.notEqual(st.body.params.talang_jumlah, 0);
  await q("UPDATE konfigurasi_dosis SET nilai = 5 WHERE param = 'jumlah_talang'");

  // petani tidak boleh membaca maupun menulis rute v4.1
  const petani = craftToken({ sub: 2, username: 'p', level: 'petani', demo: false }, { expiresIn: '10m' });
  assert.equal((await request(srv.base).get('/iot-v41/state').set(bearer(petani))).status, 403);
  assert.equal((await request(srv.base).post('/iot-v41/dosing-manual').set(bearer(petani)).send({ aksi: 'stop' })).status, 403);
  // tanpa token
  assert.equal((await request(srv.base).post('/iot-v41/dosing-manual').send({ aksi: 'stop' })).status, 401);
});
