'use strict';
/**
 * PENILAI PERINGATAN — Kontrak MQTT v2.0 §3 & §9, Perancangan v5.0 §7.1:
 * alat tidak mengirim peringatan; server menilai dari angka sensor & keadaan alat (firmware v6).
 *
 * Tiap 30 dtk: kondisiSekarang() → kondisi yang sedang benar. Kondisi menjadi KEJADIAN di alert_logs
 * (kunci_kejadian, selesai_pada NULL = sedang terjadi) setelah bertahan `tunda` detik, lalu ditutup
 * sendiri setelah pulih `pulih` detik. Satu kejadian aktif per kondisi (indeks unik parsial).
 */
const { q } = require('./db');
const { thresholdsMap } = require('./routes/monitoring');
const { statusEstop } = require('./aktuator');
const { bacaKeadaanAlat } = require('./keadaanAlat');

const INTERVAL_MS = 30_000;
/** Nilai sensor harus keluar batas selama ini sebelum menjadi peringatan (lonjakan sesaat diabaikan). */
const TUNDA_SENSOR = 300;
const PULIH_SENSOR = 300;
/** Saat SEMAI, ppm jauh dari target baru diperingatkan setelah ini (dosing + monitoring alat butuh waktu). */
const TUNDA_TARGET_PPM = 3600;
// shortcut: toleransi & batas harian = bawaan firmware (Kontrak §6.4); baca dari konfigurasi DB bila web sudah mengirim KONFIGURASI.
const TOLERANSI_PPM = { bawah: 50, atas: 100 };
const BATAS_HARIAN = [
  ['dosing_ab_hari', 6, 'dosing nutrisi AB'], ['dosing_ph_hari', 5, 'koreksi pH'],
  ['encer_hari', 3, 'pengenceran'], ['isi_hari', 6, 'isi air'],
];
const SENSOR = [
  ['ph', 'pH', '', 2], ['waterTemp', 'Suhu air', ' °C', 1], ['tds', 'Nutrisi', ' ppm', 0],
  ['airTemp', 'Suhu udara', ' °C', 1], ['humidity', 'Kelembapan', ' %', 0],
];
const PESAN_KUNCI = {
  FLOAT_ERROR: 'Pelampung error: float atas naik saat float bawah turun (float macet / kabel putus)',
  ISI_SERING: 'Pompa isi terkunci: isi air terlalu sering hari ini (curiga bocor)',
  ISI_TIMEOUT: 'Pompa isi terkunci: >15 menit air belum penuh (sumber air habis / bocor?)',
  POMPA_KELAMAAN: 'Pompa dimatikan paksa: menyala melebihi batas waktu aman',
  SENSOR_RUSAK: 'Sensor tidak terbaca 3x berturut-turut (probe belum terpasang / kabel lepas); dosing ditahan',
  EC_CURIGA: 'ppm turun mendadak >40% tanpa isi air (probe EC terangkat?); dosing ditahan',
};

const teks = (v, d) => Number(v).toFixed(d).replace('.', ',');

/** Satu kondisi. severity: critical (merah) | warning (kuning). */
const kondisi = (kunci, severity, pesan, tunda = 0, pulih = 60) => ({ kunci, severity, pesan: pesan.slice(0, 100), tunda, pulih });

function kondisiAlat(a, estopServer) {
  const hasil = [];
  if (estopServer || a.estop) {
    hasil.push(kondisi('estop', 'critical', estopServer
      ? 'E-STOP dari server aktif: semua pompa mati sampai admin membukanya'
      : 'E-STOP aktif: semua pompa mati. Lepas tombol lalu tekan RESET di box', 0, 0));
  }
  if (a.kunci) hasil.push(kondisi(`kunci_${a.kunci.toLowerCase()}`, 'critical', PESAN_KUNCI[a.kunci] || `Alat terkunci: ${a.kunci}`));
  if (a.siap === false) hasil.push(kondisi('belum_siap', 'warning', `Alat belum siap semai: belum ada ${a.kurang || 'konfigurasi lengkap'}`, 60));
  if (a.ppm_terlalu_rendah) hasil.push(kondisi('ppm_probe', 'warning', 'ppm hampir 0 saat semai: cek probe EC terendam', TUNDA_SENSOR));
  if (a.level_air === 'RENDAH' && a.mode === 'SEMAI') hasil.push(kondisi('air_rendah', 'warning', 'Air tandon RENDAH saat semai', TUNDA_SENSOR));
  for (const [kunci, maks, nama] of BATAS_HARIAN) {
    if (a[kunci] != null && a[kunci] >= maks) {
      hasil.push(kondisi(`batas_${kunci}`, 'warning', `Batas harian ${nama} penuh (${a[kunci]}/${maks}); alat menunggu besok`));
    }
  }
  return hasil;
}

/** Batas yang berlaku: saat SEMAI pakai target alat (pH min/maks, ppm ± toleransi), selainnya Ambang Sensor. */
function batasSensor(k, a, ambang) {
  if (a.mode === 'SEMAI' && k === 'ph' && a.ph_min != null && a.ph_max != null) {
    return { min: a.ph_min, max: a.ph_max, sumber: 'target semai', tunda: TUNDA_SENSOR };
  }
  if (a.mode === 'SEMAI' && k === 'tds' && a.target_ppm != null) {
    return { min: a.target_ppm - TOLERANSI_PPM.bawah, max: a.target_ppm + TOLERANSI_PPM.atas, sumber: `target ${a.target_ppm} ppm`, tunda: TUNDA_TARGET_PPM };
  }
  const b = ambang?.[k];
  const min = b?.min == null ? null : Number(b.min);
  const max = b?.max == null ? null : Number(b.max);
  if (min == null || max == null || !(min < max)) return null; // batas belum diatur / terbalik: tidak dinilai
  return { min, max, sumber: 'batas aman', tunda: TUNDA_SENSOR };
}

function kondisiSensor(sensor, a, ambang) {
  const hasil = [];
  for (const [k, nama, satuan, d] of SENSOR) {
    const v = sensor?.[k];
    if (v == null || !Number.isFinite(Number(v))) continue; // sensor tidak dikirim alat = tidak dinilai
    if ((k === 'ph' || k === 'tds') && (a.kunci === 'SENSOR_RUSAK' || a.kunci === 'EC_CURIGA')) continue; // probe tidak dipercaya
    const b = batasSensor(k, a, ambang);
    if (!b) continue;
    const n = Number(v);
    if (n >= b.min && n <= b.max) continue;
    const jauh = (b.max - b.min) * 0.25; // > 25% lebar rentang di luar batas = merah
    const severity = n < b.min - jauh || n > b.max + jauh ? 'critical' : 'warning';
    const arah = n < b.min ? 'di bawah' : 'di atas';
    hasil.push(kondisi(`sensor_${k}`, severity,
      `${nama} ${teks(n, d)}${satuan} ${arah} ${b.sumber} ${teks(b.min, d)}–${teks(b.max, d)}${satuan}`, b.tunda, PULIH_SENSOR));
  }
  return hasil;
}

/**
 * Kondisi yang sedang benar (fungsi murni, diuji di test/peringatan.test.js).
 * @param {{online: boolean, dataSegar: boolean, estopServer: boolean, alat: object, sensor: object|null, ambang: object}} s
 */
function kondisiSekarang(s) {
  if (!s.online) return [kondisi('alat_offline', 'warning', 'Alat tidak terhubung ke server: cek listrik dan Wi-Fi alat', 0, 0)];
  const hasil = kondisiAlat(s.alat, s.estopServer);
  if (!s.dataSegar) {
    hasil.push(kondisi('data_tidak_masuk', 'warning', 'Alat terhubung tetapi bacaan sensor tidak masuk', TUNDA_SENSOR));
    return hasil;
  }
  if (s.alat.pemeliharaan) return hasil; // kalibrasi / uji pompa: angka sensor sengaja tidak normal
  return hasil.concat(kondisiSensor(s.sensor, s.alat, s.ambang));
}

/* ── mesin kejadian ────────────────────────────────────────────────── */
const mulai = new Map();      // kunci → ms pertama kali benar (belum tentu sudah dibuka)
const pulihSejak = new Map(); // kunci → ms pertama kali tidak benar saat kejadian masih terbuka
const lamaPulih = new Map();  // kunci → detik pulih terakhir yang diketahui

async function terapkan(daftar, kini = Date.now()) {
  const terbuka = new Map((await q(
    'SELECT id, kunci_kejadian, value, severity FROM alert_logs WHERE kunci_kejadian IS NOT NULL AND selesai_pada IS NULL'))
    .map((r) => [r.kunci_kejadian, r]));
  const benar = new Set();
  for (const k of daftar) {
    benar.add(k.kunci);
    lamaPulih.set(k.kunci, k.pulih);
    pulihSejak.delete(k.kunci);
    if (!mulai.has(k.kunci)) mulai.set(k.kunci, kini);
    const ada = terbuka.get(k.kunci);
    if (ada) {
      if (ada.value !== k.pesan || ada.severity !== k.severity) {
        await q('UPDATE alert_logs SET value = $2, severity = $3, updated_at = now() WHERE id = $1', [ada.id, k.pesan, k.severity]);
      }
    } else if (kini - mulai.get(k.kunci) >= k.tunda * 1000) {
      await q(`INSERT INTO alert_logs (type, value, severity, locked, kunci_kejadian, created_at, updated_at)
               VALUES ($1, $2, $3, false, $1, now(), now())
               ON CONFLICT (kunci_kejadian) WHERE kunci_kejadian IS NOT NULL AND selesai_pada IS NULL DO NOTHING`,
      [k.kunci, k.pesan, k.severity]);
    }
  }
  for (const kunci of [...mulai.keys()]) if (!benar.has(kunci)) mulai.delete(kunci);
  for (const [kunci, row] of terbuka) {
    if (benar.has(kunci)) continue;
    if (!pulihSejak.has(kunci)) pulihSejak.set(kunci, kini);
    if (kini - pulihSejak.get(kunci) >= (lamaPulih.get(kunci) ?? PULIH_SENSOR) * 1000) {
      await q('UPDATE alert_logs SET selesai_pada = now(), updated_at = now() WHERE id = $1', [row.id]);
      pulihSejak.delete(kunci);
    }
  }
}

async function nilaiSekali() {
  const sensor = (await q('SELECT * FROM monitorings ORDER BY created_at DESC, id DESC LIMIT 1'))[0] ?? null;
  const [{ iotStatus, keadaanAlat }, ambang, es] = await Promise.all([bacaKeadaanAlat(sensor), thresholdsMap(), statusEstop()]);
  await terapkan(kondisiSekarang({
    online: iotStatus.online, dataSegar: iotStatus.data_segar, estopServer: es.nilai === '1',
    alat: keadaanAlat, sensor, ambang,
  }));
}

let timer = null;
function mulaiPenilai() {
  if (timer || process.env.PERINGATAN_OTOMATIS === '0') return;
  const jalan = () => nilaiSekali().catch((e) => console.error('[PERINGATAN] gagal menilai:', e.message));
  timer = setInterval(jalan, INTERVAL_MS);
  timer.unref();
  jalan();
}

module.exports = { kondisiSekarang, terapkan, nilaiSekali, mulai: mulaiPenilai, TUNDA_SENSOR };
