'use strict';
/**
 * DIAGNOSA & TABEL ASISTEN AI — deterministik (tanpa LLM).
 * Semua angka berasal langsung dari PostgreSQL; hasilnya berupa tabel terstruktur
 * { judul, kolom:[], baris:[[]] } sehingga web & Flutter merender dengan cara yang sama
 * dan tidak ada permukaan injeksi prompt.
 */
const { q, one } = require('./db');

const BATAS_DOSIS_HARI = 8;       // Perancangan FINAL seksi 1.6
const BATAS_AB_ML_HARI = 500;     // Tabel 13
const ONLINE_DETIK = 120;

const OK = 'OK';
const PERHATIAN = 'PERHATIAN';
const KRITIS = 'KRITIS';
const URUT = { [OK]: 0, [PERHATIAN]: 1, [KRITIS]: 2 };
const terburuk = (a, b) => (URUT[b] > URUT[a] ? b : a);

const fmt = (v, d = 1) => (v == null || Number.isNaN(Number(v)) ? '-' : Number(v).toFixed(d));
function umur(detik) {
  if (detik == null) return '-';
  const s = Math.max(0, Math.round(Number(detik)));
  if (s < 60) return `${s} dtk`;
  if (s < 3600) return `${Math.round(s / 60)} mnt`;
  if (s < 86400) return `${Math.round(s / 3600)} jam`;
  return `${Math.round(s / 86400)} hari`;
}
const tgl = (v) => {
  if (!v) return '-';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'][d.getMonth()]} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const tabel = (judul, kolom, baris) => ({ judul, kolom, baris });

async function aman(fn, cadangan) {
  try { return await fn(); } catch (e) { return cadangan === undefined ? { galat: String(e.code || e.message || e).slice(0, 60) } : cadangan; }
}

/* ── penilai sensor terhadap ambang ──────────────────────────────────── */
const SENSOR = [
  ['ph', 'pH', 2], ['tds', 'TDS', 0], ['waterTemp', 'Suhu air', 1], ['airTemp', 'Suhu udara', 1], ['humidity', 'Kelembapan', 0],
];
function nilaiStatus(ambang, key, v) {
  const th = ambang && ambang[key];
  if (v == null) return null;
  if (!th) return OK;
  if (th.min != null && Number(v) < Number(th.min)) return KRITIS;
  if (th.max != null && Number(v) > Number(th.max)) return KRITIS;
  return OK;
}

/* ── tabel-tabel dasar ───────────────────────────────────────────────── */
async function sensorPerMeja(ambang) {
  const rows = await q(`
    SELECT j.id_meja, j.meja, r."waterTemp", r.ph, r.tds, r."airTemp", r.humidity, r.created_at,
           EXTRACT(EPOCH FROM (LOCALTIMESTAMP - r.created_at)) AS umur
    FROM mejas j
    LEFT JOIN LATERAL (
      SELECT * FROM monitorings m WHERE m.id_meja = j.id_meja ORDER BY m.created_at DESC LIMIT 1
    ) r ON true
    ORDER BY j.id_meja LIMIT 20`);
  const glob = await one(`
    SELECT *, EXTRACT(EPOCH FROM (LOCALTIMESTAMP - created_at)) AS umur
    FROM monitorings ORDER BY created_at DESC LIMIT 1`);
  const baris = [];
  const temuan = [];
  let status = OK;
  const tambah = (nama, r) => {
    if (!r || r.created_at == null) {
      baris.push([nama, '-', '-', '-', '-', '-', '-', 'TIDAK ADA DATA']);
      return;
    }
    const luar = [];
    for (const [k, label] of SENSOR) {
      if (nilaiStatus(ambang, k, r[k]) === KRITIS) luar.push(label);
    }
    const basi = Number(r.umur) > ONLINE_DETIK;
    const st = luar.length ? `DI LUAR: ${luar.join(', ')}` : (basi ? 'BASI' : OK);
    if (luar.length) { status = terburuk(status, KRITIS); temuan.push(`${nama}: ${luar.join(', ')} di luar ambang`); } else if (basi) status = terburuk(status, PERHATIAN);
    baris.push([nama, fmt(r.ph, 2), fmt(r.tds, 0), fmt(r.waterTemp), fmt(r.airTemp), fmt(r.humidity, 0), umur(r.umur), st]);
  };
  for (const r of rows) tambah(r.meja, r);
  if (!rows.some((r) => r.created_at) && glob) tambah('Global (tanpa meja)', glob);
  else if (!rows.length) tambah('Global', glob);
  return {
    status, temuan, online: glob ? Number(glob.umur) <= ONLINE_DETIK : false, umurGlobal: glob ? Number(glob.umur) : null,
    tabel: tabel('Sensor terbaru per meja', ['Meja', 'pH', 'TDS ppm', 'Suhu air °C', 'Suhu udara °C', 'Lembap %', 'Umur data', 'Status'], baris),
  };
}

async function tabelRiwayatSensor(n = 10) {
  const lim = Math.min(Math.max(Number(n) || 10, 1), 20);
  const rows = await q(`
    SELECT m.created_at, j.meja, m.ph, m.tds, m."waterTemp", m."airTemp", m.humidity
    FROM monitorings m LEFT JOIN mejas j ON j.id_meja = m.id_meja
    ORDER BY m.created_at DESC LIMIT $1`, [lim]);
  return tabel(`Bacaan sensor terakhir (${rows.length})`, ['Waktu', 'Meja', 'pH', 'TDS ppm', 'Suhu air °C', 'Suhu udara °C', 'Lembap %'],
    rows.map((r) => [tgl(r.created_at), r.meja || '-', fmt(r.ph, 2), fmt(r.tds, 0), fmt(r.waterTemp), fmt(r.airTemp), fmt(r.humidity, 0)]));
}

async function tabelAlert() {
  const rows = await q(`
    SELECT a.id, a.type, a.value, a.severity, a.locked, a.created_at, j.meja
    FROM alert_logs a LEFT JOIN mejas j ON j.id_meja = a.id_meja
    WHERE a.acknowledged IS NOT TRUE
    ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.created_at DESC
    LIMIT 12`);
  const total = await one('SELECT count(*)::int AS n FROM alert_logs WHERE acknowledged IS NOT TRUE');
  return {
    total: total ? total.n : rows.length,
    kritis: rows.filter((r) => r.severity === 'critical').length,
    terkunci: rows.filter((r) => r.locked).length,
    tabel: tabel(`Alert terbuka (${total ? total.n : rows.length})`, ['Waktu', 'Meja', 'Jenis', 'Nilai', 'Tingkat', 'LOCK'],
      rows.map((r) => [tgl(r.created_at), r.meja || '-', r.type, String(r.value).slice(0, 40), r.severity, r.locked ? 'ya' : '-'])),
  };
}

async function tabelPenampung() {
  const rows = await q(`
    SELECT j.meja, j.jenis_talang, p.status_lock, p.lock_alasan, p.mode_pemeliharaan,
           p.kejadian_dosis_hari, p.volume_ab_hari_ml, p.volume_ph_hari_ml, p.target_ec_ppm, p.target_ph
    FROM mejas j LEFT JOIN penampung_states p ON p.id_meja = j.id_meja
    ORDER BY j.id_meja LIMIT 20`);
  let status = OK;
  const temuan = [];
  const baris = rows.map((r) => {
    let st = OK;
    if (r.status_lock) { st = KRITIS; temuan.push(`${r.meja}: LOCK (${r.lock_alasan || 'tanpa alasan'})`); } else if (r.mode_pemeliharaan) { st = PERHATIAN; temuan.push(`${r.meja}: mode pemeliharaan aktif`); } else if (Number(r.kejadian_dosis_hari) >= BATAS_DOSIS_HARI - 1 || Number(r.volume_ab_hari_ml) >= BATAS_AB_ML_HARI * 0.9) {
      st = PERHATIAN; temuan.push(`${r.meja}: jatah dosis harian hampir habis`);
    }
    status = terburuk(status, st);
    return [r.meja, r.jenis_talang || '-',
      r.status_lock ? `LOCK${r.lock_alasan ? ` · ${r.lock_alasan}` : ''}` : (r.mode_pemeliharaan ? 'PEMELIHARAAN' : 'normal'),
      `${r.kejadian_dosis_hari ?? 0}/${BATAS_DOSIS_HARI}`, `${fmt(r.volume_ab_hari_ml, 0)}/${BATAS_AB_ML_HARI}`,
      fmt(r.target_ec_ppm, 0), fmt(r.target_ph, 1)];
  });
  return {
    status, temuan,
    tabel: tabel('Penampung & dosing', ['Meja', 'Jenis', 'Status', 'Dosis/hari', 'AB mL/hari', 'Target EC', 'Target pH'], baris),
  };
}

function tabelTahap(tahap) {
  const baris = (tahap || []).map((t) => [
    t.tahap, t.nama_tanaman || '-', t.status,
    t.hari_berjalan == null ? '-' : `${t.hari_berjalan}${t.durasi_hari != null ? `/${t.durasi_hari}` : ''} hari`,
    t.sisa_hari == null ? '-' : `${t.sisa_hari} hari`,
    t.lewat_durasi ? 'LEWAT DURASI' : (t.mendekati_durasi ? 'segera selesai' : OK),
  ]);
  return tabel('Tahap tanam terbaru', ['Tahap', 'Tanaman', 'Status', 'Berjalan', 'Sisa', 'Catatan'], baris);
}

/* ── diagnosa menyeluruh ─────────────────────────────────────────────── */
async function diagnosaMenyeluruh(data) {
  const komponen = [];   // [Komponen, Status, Detail, Saran]
  const saran = [];
  const tambah = (nama, st, detail, tindakan) => {
    komponen.push([nama, st, detail, tindakan || '-']);
    if (tindakan && st !== OK) saran.push(`${nama}: ${tindakan}`);
  };

  // 1) basis data
  const t0 = Date.now();
  const db = await aman(() => one('SELECT 1 AS ok'));
  const ms = Date.now() - t0;
  if (!db || db.galat) tambah('Basis data', KRITIS, `gagal terhubung (${db && db.galat})`, 'Periksa PostgreSQL dan DATABASE_URL di .env');
  else tambah('Basis data', ms > 500 ? PERHATIAN : OK, `terhubung · ${ms} ms`, ms > 500 ? 'Respons lambat — cek beban/indeks DB' : null);

  const mig = await aman(() => one("SELECT to_regclass('schema_migrations') IS NOT NULL AS ada"), null);
  if (mig && mig.ada) {
    const n = await aman(() => one('SELECT count(*)::int AS n FROM schema_migrations'), null);
    tambah('Migrasi skema', OK, `${n ? n.n : '?'} migrasi tercatat`);
  } else {
    tambah('Migrasi skema', PERHATIAN, 'tabel schema_migrations belum ada', 'Jalankan: npm run migrate');
  }

  // 2) sensor per meja
  const ambang = (data && data.ambang) || {};
  const sp = await aman(() => sensorPerMeja(ambang));
  let tSensor = null;
  if (!sp || sp.galat) tambah('Data sensor', KRITIS, `tidak terbaca (${sp && sp.galat})`, 'Periksa tabel monitorings');
  else {
    tSensor = sp.tabel;
    if (sp.umurGlobal == null) tambah('Koneksi ESP32', KRITIS, 'belum ada satu pun bacaan', 'Nyalakan ESP32 / cek API key & jaringan');
    else if (!sp.online) tambah('Koneksi ESP32', KRITIS, `OFFLINE · data terakhir ${umur(sp.umurGlobal)} lalu`, 'Cek daya, WiFi, dan API key ESP32');
    else tambah('Koneksi ESP32', OK, `ONLINE · data terakhir ${umur(sp.umurGlobal)} lalu`);
    tambah('Nilai sensor', sp.status === KRITIS ? KRITIS : (sp.status === PERHATIAN ? PERHATIAN : OK),
      sp.temuan.length ? sp.temuan.join('; ') : (sp.status === PERHATIAN ? 'data sudah basi — nilai terakhir belum bisa dianggap terkini' : 'semua dalam ambang'),
      sp.temuan.length ? 'Koreksi larutan (pH/nutrisi/suhu) lalu pantau 15 menit' : null);
  }

  // 3) alert
  const al = await aman(() => tabelAlert());
  let tAlert = null;
  if (al && !al.galat) {
    tAlert = al.total ? al.tabel : null;
    const st = al.kritis || al.terkunci ? KRITIS : (al.total ? PERHATIAN : OK);
    tambah('Alert', st, al.total ? `${al.total} terbuka · ${al.kritis} kritis · ${al.terkunci} memicu LOCK` : 'tidak ada alert terbuka',
      al.total ? 'Tinjau dan tandai selesai di halaman Alert' : null);
  } else tambah('Alert', PERHATIAN, `tidak terbaca (${al && al.galat})`, 'Periksa tabel alert_logs');

  // 4) penampung / dosing
  const pn = await aman(() => tabelPenampung());
  let tPen = null;
  if (pn && !pn.galat) {
    tPen = pn.tabel;
    tambah('Penampung & dosing', pn.status, pn.temuan.length ? pn.temuan.join('; ') : 'semua penampung normal',
      pn.status === KRITIS ? 'Selidiki penyebab LOCK lalu reset dari halaman Kontrol' : (pn.status === PERHATIAN ? 'Pantau jatah dosis / selesaikan pemeliharaan' : null));
  } else tambah('Penampung & dosing', PERHATIAN, 'tabel penampung_states belum tersedia', 'Jalankan: npm run migrate');

  // 5) tahap tanam
  const tahap = (data && data.tahap) || [];
  const lewat = tahap.filter((x) => x.lewat_durasi);
  const dekat = tahap.filter((x) => x.mendekati_durasi && !x.lewat_durasi);
  if (!tahap.length) tambah('Tahap tanam', PERHATIAN, 'belum ada data tanam', 'Mulai siklus di halaman Tanam');
  else if (lewat.length) tambah('Tahap tanam', KRITIS, lewat.map((x) => `${x.tahap} melewati durasi`).join('; '), 'Tutup tahap & lanjutkan ke tahap berikutnya');
  else if (dekat.length) tambah('Tahap tanam', PERHATIAN, dekat.map((x) => `${x.tahap} segera selesai`).join('; '), 'Siapkan tahap berikutnya');
  else tambah('Tahap tanam', OK, `${tahap.filter((x) => x.status === 'berjalan').length} tahap berjalan sesuai jadwal`);

  // 6) CCTV
  const cc = await aman(() => one("SELECT count(*)::int AS total, count(*) FILTER (WHERE aktif)::int AS aktif FROM cctv_kameras"), null);
  if (cc) tambah('CCTV', cc.aktif ? OK : PERHATIAN, `${cc.aktif}/${cc.total} kamera aktif`, cc.aktif ? null : 'Aktifkan atau tambah kamera di halaman CCTV');
  else tambah('CCTV', PERHATIAN, 'tabel kamera belum ada', 'Jalankan: npm run migrate');

  let total = OK;
  for (const k of komponen) total = terburuk(total, k[1]);
  const jml = (s) => komponen.filter((k) => k[1] === s).length;
  const ringkasan = total === OK
    ? `Diagnosa menyeluruh: semua ${komponen.length} komponen sehat.`
    : `Diagnosa menyeluruh: ${jml(KRITIS)} kritis, ${jml(PERHATIAN)} perlu perhatian, ${jml(OK)} sehat dari ${komponen.length} komponen.`;

  const tabelSemua = [tabel('Hasil pemeriksaan', ['Komponen', 'Status', 'Detail', 'Saran'], komponen)];
  if (tSensor) tabelSemua.push(tSensor);
  if (tPen) tabelSemua.push(tPen);
  if (tAlert) tabelSemua.push(tAlert);
  if (tahap.length) tabelSemua.push(tabelTahap(tahap));
  return { status: total, ringkasan, saran: saran.slice(0, 6), tabel: tabelSemua };
}

/* ── pemetaan niat → jawaban deterministik ───────────────────────────── */
function deteksiNiat(pesanTernormalisasi) {
  const s = pesanTernormalisasi;
  if (/\b(?:diagnos\w*|debug\w*|troubleshoot\w*|health ?check|pemeriksaan (?:menyeluruh|lengkap)|(?:periksa|cek|audit|scan)\s+(?:semua|seluruh|menyeluruh|sistem|kesehatan)|status sistem|kondisi sistem|ada (?:masalah|error))/.test(s)) return 'diagnosa';
  if (/\b(?:tabel|daftar|list|rekap)\b.{0,25}\b(?:alert|peringatan)|\balert\b.{0,20}\b(?:terbuka|apa saja|aktif)/.test(s)) return 'alert';
  if (/\b(?:tabel|daftar|rekap|status)\b.{0,25}\b(?:penampung|dosing|dosis|lock)|\b(?:penampung|dosing|dosis)\b.{0,20}\b(?:status|tabel|kondisi)/.test(s)) return 'penampung';
  if (/\b(?:tabel|daftar|rekap|status)\b.{0,25}\b(?:tahap|tanam\w*|siklus)/.test(s)) return 'tahap';
  if (/\b(?:tabel|rekap|riwayat|history)\b.{0,25}\b(?:sensor|bacaan|ph|tds|monitoring)|\bsensor\b.{0,15}\b(?:tabel|riwayat)/.test(s)) return 'sensor';
  if (/\btabel\b/.test(s)) return 'sensor';
  return null;
}

async function jawabNiat(niat, data) {
  if (niat === 'diagnosa') {
    const d = await diagnosaMenyeluruh(data);
    return { jawaban: d.ringkasan + (d.saran.length ? `\nTindakan yang disarankan:\n${d.saran.map((x) => `• ${x}`).join('\n')}` : ''), tabel: d.tabel, status: d.status };
  }
  if (niat === 'alert') {
    const a = await tabelAlert();
    return { jawaban: a.total ? `Ada ${a.total} alert terbuka (${a.kritis} kritis).` : 'Tidak ada alert terbuka.', tabel: a.total ? [a.tabel] : [], status: a.kritis ? KRITIS : (a.total ? PERHATIAN : OK) };
  }
  if (niat === 'penampung') {
    const p = await tabelPenampung();
    return { jawaban: p.temuan.length ? p.temuan.join('. ') + '.' : 'Semua penampung dalam kondisi normal.', tabel: [p.tabel], status: p.status };
  }
  if (niat === 'tahap') {
    return { jawaban: (data.tahap || []).length ? 'Tahap tanam terbaru per tahap.' : 'Belum ada data tanam.', tabel: (data.tahap || []).length ? [tabelTahap(data.tahap)] : [], status: OK };
  }
  const [t, sp] = await Promise.all([tabelRiwayatSensor(10), aman(() => sensorPerMeja((data && data.ambang) || {}))]);
  const tabelSemua = [];
  if (sp && !sp.galat) tabelSemua.push(sp.tabel);
  tabelSemua.push(t);
  return { jawaban: sp && !sp.galat && sp.temuan.length ? `Perhatian: ${sp.temuan.join('; ')}.` : 'Berikut data sensor terbaru.', tabel: tabelSemua, status: sp && !sp.galat ? sp.status : OK };
}

/* ── ekstrak tabel markdown dari jawaban LLM → tabel terstruktur ─────── */
function ekstrakTabelMarkdown(teks) {
  const baris = String(teks || '').split('\n');
  const sisa = [];
  const hasil = [];
  const sel = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim().slice(0, 60));
  for (let i = 0; i < baris.length; i += 1) {
    const l = baris[i];
    const sep = baris[i + 1];
    if (l.includes('|') && sep && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(sep)) {
      const kolom = sel(l).slice(0, 8);
      const isi = [];
      let j = i + 2;
      while (j < baris.length && baris[j].includes('|') && isi.length < 30) {
        const c = sel(baris[j]);
        isi.push(kolom.map((_, k) => c[k] || '-'));
        j += 1;
      }
      if (kolom.length >= 2 && isi.length) hasil.push(tabel('Tabel', kolom, isi));
      i = j - 1;
    } else sisa.push(l);
  }
  return { teks: sisa.join('\n').replace(/\n{3,}/g, '\n\n').trim(), tabel: hasil.slice(0, 3) };
}

module.exports = {
  diagnosaMenyeluruh, deteksiNiat, jawabNiat, ekstrakTabelMarkdown,
  tabelRiwayatSensor, tabelAlert, tabelPenampung, tabelTahap, sensorPerMeja,
  OK, PERHATIAN, KRITIS,
};
