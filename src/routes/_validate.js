'use strict';
/**
 * Validasi body input dengan Zod — dipakai rute CRUD generik (src/routes/_crud.js).
 *
 * Latar (bug yang ditemukan agen debugger): tanpa validasi tipe, input tak terduga
 * membuat PostgreSQL melempar error → [500], dan objek justru TERSIMPAN sembarangan
 * ({"meja":{"a":1}} pernah menjadi string '{"a":1}' di kolom meja). Dengan Zod semua
 * input tak terduga — objek, array, null, NaN, string kosong, teks > maxLen, angka di
 * luar rentang int4 — kini ditolak 422 TERSTRUKTUR sesuai kontrak
 * (docs/KONTRAK_API.md §2), sama gaya dengan 422 login:
 *     422 {"message":"Data tidak valid.","errors":{"<field>":["pesan"]}}
 *
 * Prinsip:
 *  - CREATE : field ber-flag `requiredCreate` wajib ada dan valid; sisanya opsional.
 *  - UPDATE : SEMUA field opsional, tetapi tipe & panjang tetap divalidasi bila dikirim.
 *  - Validasi berjalan SEBELUM query (lihat _crud.js) → data tak pernah tersentuh saat
 *    request ditolak; path param :id tetap divalidasi oleh ./_id (validId) SEBELUM
 *    validasi body, sehingga 404 identik tidak berubah.
 *  - Field di luar whitelist TIDAK divalidasi di sini (Zod membuangnya dari hasil
 *    parse) — handler tetap membuangnya lewat mekanisme console.warn yang sudah ada.
 *  - Tabel tanpa spec eksplisit memakai inferensi longgar (string 1..500 / integer
 *    int4 / id_ → bigint / tgl_* & tanggal → pola YYYY-MM-DD) supaya SEMUA tabel ikut
 *    terlindungi tanpa menebak-nebak nilai yang boleh (tidak ada asumsi enum yang
 *    tidak terdokumentasi).
 *  - Panjang teks EFEKTIF = MIN(batas spec/inferensi, panjang kolom aktual dari
 *    information_schema) — dibaca sekali saat startup lewat loadColumnLengths().
 *    Kolom live mis. mejas.meja varchar(50), tanamen.nama_tanaman varchar(50),
 *    sikluses.nama_siklus varchar(100), semais.status varchar(255); tanpa pembatasan
 *    ini teks 60/150/300 karakter lolos validasi lalu dibuang PostgreSQL dengan
 *    'value too long for type character varying' → 500. Bila query gagal / peta belum
 *    ada, fallback ke batas spec (perilaku lama) — server tetap jalan.
 *
 * Pilihan Zod (bukan ajv/Joi) mengacu RISET_PENGEMBANGAN_GARAP.md: nol dependensi
 * inti, ringan, dan skema bisa dipakai ulang untuk dokumentasi OpenAPI.
 */
const { z } = require('zod');
const { q } = require('../db'); // hanya SELECT information_schema — lihat loadColumnLengths()

/** Batas integer (int4) Postgres — kolom integer mentah. */
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;
/** Batas teks default untuk kolom varchar tanpa spec eksplisit (dibatasi lagi oleh panjang kolom DB). */
const DEFAULT_STR_MAX = 500;
/** Pesan seragam untuk body yang bukan objek JSON (null/array/angka/teks). */
const MSG_BODY = 'Body harus berupa objek JSON.';
/** Pola tanggal ISO untuk kolom tipe date PostgreSQL (YYYY-MM-DD). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Pola nama kolom bertipe tanggal di luar spec eksplisit: prefiks `tgl_`
 * (tgl_awal_semai, tgl_akhir_peremajaan, tgl_panen, ...) dan `tanggal*`.
 * Semua kolom ini bertipe `date` (docs/DB_SCHEMA.md) sehingga tanpa validasi pola
 * nilai seperti 'bukan-tanggal' lolos Zod (dulu dianggap string bebas) lalu
 * PostgreSQL melempar "invalid input syntax for type date" → 500.
 */
const DATE_NAME = /^(tgl_|tanggal)/;

/**
 * True bila `v` adalah string YYYY-MM-DD yang benar-benar ada di kalender
 * ('2026-13-45' lolos pola tetap TIDAK lolos fungsi ini — dulu membuat
 * PostgreSQL melempar 'date/time field value out of range' → 500).
 */
function isDateString(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Cek komponen tanggal terhadap kalender Gregorian (bulan 1-12, hari sesuai
 * bulan & tahun kabisat). Tahun 0 ditolak — PostgreSQL sendiri menolaknya
 * (22008 'date/time field value out of range').
 */
function kalenderOk(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1 || y > 99999 || m < 1 || m > 12) return false;
  const hari = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d >= 1 && d <= hari[m - 1];
}

/**
 * Validasi nilai query `?dari=` / `?sampai=` SEBELUM SQL (temuan G10:
 * 'bukan-tanggal','2026-13-45','2026-02-30','1e5','2026-01-01T99:99:99' dahulu
 * membuat `$1::timestamptz` melempar 22007/22008 → 500).
 *
 * KEPUTUSAN FORMAT (dikunci di sini — dikirim ulang ke kontrak lewat komentar ini):
 *  - FE (react-web-app SensorRealtimePage) memakai <input type="date"> →
 *    YYYY-MM-DD; format itulah yang dijanjikan.
 *  - Nilai yang PERNAH diterima PostgreSQL selama ini TETAP diterima supaya
 *    kontrol tidak berubah: literal 'infinity' & '-infinity', tanggal
 *    satu-digit ('2026-1-1'), padat '20260101', tahun ≥5 digit ('99999-01-01'),
 *    ISO datetime dgn 'T'/' ' + zona (Z/±HH:MM, offset maksimal ±15:59),
 *    '2026-01-01T24:00:00' (tengah malam PG), dan spasi pinggir (di-trim,
 *    PostgreSQL juga mengabaikannya).
 *  - Ditolak: bukan teks (array ?dari[]=1), tahun 0, bulan/hari/tidak kabisat
 *    di luar kalender, jam > 24 (atau 24:xx selain 24:00:00), menit/detik > 59,
 *    offset > 15:59 (PG 22009), angka berpangkat '1e5', teks bebas.
 * Rentang terbalik / kosong TIDAK divalidasi di sini: dibiarkan seperti selama
 * ini (kueri menghasilkan baris kosong → 200).
 * @param {unknown} v nilai query (string | array | objek | undefined)
 * @returns {boolean} true bila aman dikirim ke $1::timestamptz / $1::date
 */
function isQueryDate(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s === '') return true;                       // '' = tanpa filter (perlakuan lama: `dari || null`)
  if (s === 'infinity' || s === '-infinity') return true;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (compact) return kalenderOk(+compact[1], +compact[2], +compact[3]);
  const m = /^(\d{1,6})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.\d{1,6})?)?(Z|z|[+-]\d{1,3}:?\d{2})?)?$/.exec(s);
  if (!m) return false;
  if (!kalenderOk(+m[1], +m[2], +m[3])) return false;
  if (m[4] === undefined) return true;              // tanggal polos YYYY-M-D
  const H = +m[4]; const M = +m[5]; const S = m[6] === undefined ? 0 : +m[6];
  if (M > 59 || S > 59) return false;
  if (H > 24 || (H === 24 && (M !== 0 || S !== 0))) return false;
  if (m[7] && m[7] !== 'Z' && m[7] !== 'z') {
    const off = /^([+-])(\d{1,3}):?(\d{2})$/.exec(m[7]);
    if (!off || +off[2] > 15 || +off[3] > 59) return false; // PG 22009: displacement maks ±15:59
  }
  return true;
}

/**
 * G10 — kumpulkan error 422 untuk query `?dari=` & `?sampai=` (empat endpoint:
 * /laporan, /laporan/csv, /monitoring/tarik, /monitoring/tarik/csv).
 * Nilai kosong/absen = tanpa filter (perlakuan lama `x || null`), nilai cacat →
 * kunci field; rentang terbalik/tanpa baris TIDAK divalidasi (tetap 200).
 * @returns {Record<string, string[]>} errors (kosong = lolos)
 */
function tanggalErrors(dari, sampai) {
  const errors = {};
  for (const [nama, nilai] of [['dari', dari], ['sampai', sampai]]) {
    if (nilai === undefined || nilai === '') continue;
    if (!isQueryDate(nilai)) {
      errors[nama] = [`Filter ${nama} harus berupa tanggal (YYYY-MM-DD / ISO-8601).`];
    }
  }
  return errors;
}

/**
 * Spec eksplisit per tabel. Key = nama kolom, value:
 *   tipe           : 'string' | 'integer' | 'number' | 'enum' | 'date'
 *   requiredCreate : wajib saat CREATE (POST); UPDATE selalu opsional
 *   minLen/maxLen  : batas panjang teks (default string: 1..500)
 *   min/max        : batas angka (integer = bilangan bulat, number = desimal);
 *                    minInclusive/maxInclusive = false → batas TERBUKA (Zod gt/lt)
 *                    dipakai untuk kolom dengan CHECK `> 0` agar nilainya tidak
 *                    lolos validasi lalu ditolak PostgreSQL (500)
 *   enum           : daftar nilai yang diizinkan (harus SENADA dengan CHECK DB)
 * Batas di bawah ini adalah batas SPESIFIKASI (docs/DB_SCHEMA.md hanya menyebut tipe
 * varchar tanpa panjang — dokumen itu TIDAK memuat varchar(200)). Batas efektif saat
 * runtime = MIN(maxLen di sini, panjang kolom aktual dari information_schema):
 * mejas.meja varchar(50) di DB live → efektif maksimal 50 karakter.
 * mejas.jumlah_lubang integer dengan rentang 1..1000000 (sesuai mandat perbaikan).
 */
const TABLE_SPECS = {
  mejas: {
    meja: { tipe: 'string', requiredCreate: true, minLen: 1, maxLen: 200 },
    jumlah_lubang: { tipe: 'integer', requiredCreate: true, min: 1, max: 1000000 },
    // — kolom fisik talang/penampung (migrasi skema V2 2026-10-19, lihat
    //   docs/ANALISIS_DB_PERANCANGAN.md §e) — SEMUANYA wajib spec eksplisit:
    //   inferSpec hanya mengenali pola jumlah_*/waktu_* sebagai integer, sehingga
    //   tanpa spec ini kapasitas/panjang/laju/kenaikan dianggap STRING (angka 70
    //   ditolak 422 yang salah) dan jenis_talang bebas → lolos Zod lalu kena
    //   CHECK DB (500, bukan 422 terstruktur).
    jenis_talang: { tipe: 'enum', enum: ['NFT', 'DFT'] },            // CHECK live: IN ('NFT','DFT')
    kapasitas_penampung_l: { tipe: 'number', min: 0, minInclusive: false, max: 999999.99 }, // CHECK > 0 · numeric(6,2)
    jumlah_talang: { tipe: 'integer', min: 0 },
    lubang_per_talang: { tipe: 'integer', min: 0 },
    panjang_talang_m: { tipe: 'number', min: 0, max: 99.99 },        // numeric(4,2)
    laju_per_talang_lpm: { tipe: 'number', min: 0, max: 999.99 },    // numeric(5,2)
    kenaikan_air_cm: { tipe: 'integer', min: 0 },                    // DEFAULT 40 di DB (dipasang lewat DEFAULT, bukan Zod)
  },
  sensor_thresholds: {
    // Daftar nilai tertutup sesuai docs/DB_SCHEMA.md (feed ESP32).
    sensor: { tipe: 'enum', enum: ['waterTemp', 'ph', 'tds', 'airTemp', 'humidity'] },
    min: { tipe: 'number' },
    max: { tipe: 'number' },
  },
  // ── Tabel konfigurasi V2 (migrasi 2026-10-19) — dipakai PUT /konfigurasi-dosis,
  //    PUT /timing-operasi, PUT /target-nutrisi (routes/konfigurasi.js). PK (param/id)
  //    tidak pernah ditulis sehingga tidak butuh spec. requiredCreate mencerminkan
  //    kolom NOT NULL tanpa DEFAULT bila kelak ada POST; hari ini hanya mode 'update'.
  konfigurasi_dosis: {
    // numeric(12,4) NOT NULL → maksimum 99999999.9999 (precision 12 − scale 4
    // = 8 digit int). min 0: dosis negatif dulu diterima 200. 1e30/-1e30 dulu →
    // 500 "numeric field overflow" (22003) karena Zod tanpa batas.
    nilai: { tipe: 'number', requiredCreate: true, min: 0, max: 99999999.9999 },
    satuan: { tipe: 'string', requiredCreate: true, minLen: 1, maxLen: 24 },
    keterangan: { tipe: 'string', minLen: 1, maxLen: 500 },          // kolom text (dibatasi DEFAULT_STR_MAX)
    sumber: { tipe: 'string', minLen: 1, maxLen: 120 },
  },
  timing_operasi: {
    // numeric(10,3) nullable → maksimum 9999999.999 (7 digit int); min 0;
    // null diizinkan karena kolom is_nullable=YES (dulu null → 422 keliru,
    // 1e12 → 500 overflow).
    nilai: { tipe: 'number', min: 0, max: 9999999.999, nullable: true },
    satuan: { tipe: 'string', requiredCreate: true, minLen: 1, maxLen: 24 },
    keterangan: { tipe: 'string', minLen: 1, maxLen: 500 },
    sumber: { tipe: 'string', minLen: 1, maxLen: 120 },
  },
  target_nutrisi: {
    // bigint — batas safe-integer mencegah 22003 saat cek FK (kolom lain memakai
    // fkErrors yang memblokir angka tak-aman serupa).
    id_tanaman: { tipe: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER },
    tahap: { tipe: 'string', requiredCreate: true, minLen: 1, maxLen: 32 },
    // integer (int4): batas atas WAJIB — 9999999999 dulu → 500 int4 out-of-range
    // (22003). Kolom nullable; null tetap ditolak Zod kecuali spec nullable.
    umur_min_hari: { tipe: 'integer', min: 0, max: INT4_MAX },
    umur_max_hari: { tipe: 'integer', min: 0, max: INT4_MAX },
    ec_min_ppm: { tipe: 'number', min: 0, max: 99999999.99 },        // numeric(8,2)
    ec_max_ppm: { tipe: 'number', min: 0, max: 99999999.99 },
    ph_min: { tipe: 'number', min: 0, max: 999.99 },                 // numeric(4,2)
    ph_max: { tipe: 'number', min: 0, max: 999.99 },
    // CHECK live: IN ('menunggu_konfirmasi','aktif','kadaluarsa')
    status: { tipe: 'enum', enum: ['menunggu_konfirmasi', 'aktif', 'kadaluarsa'] },
    keterangan: { tipe: 'string', minLen: 1, maxLen: 500 },
    sumber: { tipe: 'string', minLen: 1, maxLen: 120 },
  },
  semais: {
    // CHECK live semais_status_check: IN ('proses','selesai','gagal') — divalidasi
    // Zod SEBELUM query (dulu PUT /semai/:id {status:'ngawur'} → 500 CHECK 23514;
    // mapper SQLSTATE di index.js tetap jaring pengaman untuk CHECK lain).
    status: { tipe: 'enum', enum: ['proses', 'selesai', 'gagal'] },
    // Kolom NOT NULL TANPA DEFAULT (information_schema live): jumlah_benih,
    // tgl_awal_semai, tgl_akhir_semai. Dulu POST /semai tanpa salah satunya lolos
    // Zod lalu jatuh ke PostgreSQL 23502 → 500. Dgn requiredCreate: 422 per-field
    // 'wajib diisi' SEBELUM SQL. Rentang jumlah_benih = rentang infer lama (int4)
    // supaya pesan 422 utk nilai yang SELAMA INI divalidasi tetap identik.
    jumlah_benih: { tipe: 'integer', requiredCreate: true, min: INT4_MIN, max: INT4_MAX },
    tgl_awal_semai: { tipe: 'date', requiredCreate: true },
    tgl_akhir_semai: { tipe: 'date', requiredCreate: true },
  },
};

/** Nama kolom bertipe desimal (bukan bulat). */
const FLOAT_COLUMNS = new Set(['min', 'max']);
/**
 * Pola nama kolom bertipe integer di luar id_: jumlah_* (jumlah_benih, jumlah_masuk),
 * waktu_* (waktu_siklus), dan *_berhasil / *_gagal (benih/tanaman/panen).
 * id_* adalah FK bigint → integer tanpa batas int4 (aman untuk Number.isSafeInteger).
 */
const INTEGER_NAME = /^(id_|jumlah_|waktu_)|_(berhasil|gagal)$/;

/**
 * Inferensi tipe longgar untuk kolom tanpa spec eksplisit.
 * @param {string} col nama kolom
 * @returns {{tipe: string, minLen?: number, maxLen?: number, min?: number, max?: number}}
 */
function inferSpec(col) {
  if (FLOAT_COLUMNS.has(col)) return { tipe: 'number' };
  if (DATE_NAME.test(col)) {
    // Kolom date (tgl_*/tanggal): string + pola YYYY-MM-DD — batas panjang lama
    // dipertahankan supaya pesan 422 untuk null/angka/teks kosong/teks kepanjangan
    // TETAP identik dengan sebelumnya; hanya nilai berformat salah yang kini 422
    // (dulu lolos validasi lalu dibuang PostgreSQL → 500).
    return { tipe: 'date', minLen: 1, maxLen: DEFAULT_STR_MAX };
  }
  if (INTEGER_NAME.test(col)) {
    // Kolom integer non-FK di DB bertipe int4 → batas int4 mencegah 'integer out of
    // range' (22003) yang dulu bocor jadi 500. id_* adalah bigint → cukup batas
    // safe-integer bawaan z.number().int().
    return /^id_/.test(col) ? { tipe: 'integer' } : { tipe: 'integer', min: INT4_MIN, max: INT4_MAX };
  }
  return { tipe: 'string', minLen: 1, maxLen: DEFAULT_STR_MAX };
}

/* ── Panjang kolom aktual dari information_schema ───────────────────────
 * Peta 'table.column' → character_maximum_length, dibaca SEKALI saat startup
 * (SELECT read-only; tidak ada DDL/DML). Supaya validasi tetap sinkron dengan DB
 * live, maxLen teks efektif = MIN(batas spec/inferensi, batas DB). Tanpa ini,
 * spec eksplisit meja 1..200 maupun inferensi 500 tetap lebih longgar daripada
 * varchar(50)/varchar(100)/varchar(255) di DB → teks panjang lolos Zod lalu jatuh
 * ke error PostgreSQL 'value too long for type character varying' (500).
 * null = peta belum/gagal dimuat → memakai batas spec (fallback perilaku lama). */
let columnLengths = null;
/** Versi peta — dinaikkan tiap peta dimuat supaya cache skema lama otomatis kadaluarsa. */
let lengthGen = 0;

/**
 * Baca panjang semua kolom bertipe varchar sekali saat startup.
 * Gagal (DB mati dsb.) → kembalikan null, catat ke log, dan biarkan batas fallback
 * berlaku — startup tidak pernah digagalkan oleh query ini.
 * @returns {Promise<Record<string, number>|null>}
 */
async function loadColumnLengths() {
  try {
    const rows = await q(`SELECT table_name, column_name, character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public' AND character_maximum_length IS NOT NULL`);
    const map = {};
    for (const r of rows) map[`${r.table_name}.${r.column_name}`] = Number(r.character_maximum_length);
    columnLengths = map;
    lengthGen += 1;
    return map;
  } catch (e) {
    console.warn(`[validate] information_schema tidak terbaca — batas panjang memakai fallback spec (${e.message})`);
    return null;
  }
}

/**
 * Batasi maxLen teks sebuah string-spec dengan panjang kolom DB = MIN(spec, DB).
 * Objek spec TIDAK dimutasi (TABLE_SPECS dipakai bersama) — selalu salinan baru.
 */
function capWithDb(spec, table, col) {
  if ((spec.tipe !== 'string' && spec.tipe !== 'date') || columnLengths === null) return spec;
  const dbLen = columnLengths[`${table}.${col}`];
  const specMax = spec.maxLen ?? DEFAULT_STR_MAX;
  if (dbLen === undefined || dbLen >= specMax) return spec;
  return { ...spec, maxLen: dbLen };
}

/** Gabungkan spec eksplisit tabel dengan inferensi untuk kolom yang belum tercantum. */
function specsFor(table, columns) {
  const explicit = TABLE_SPECS[table] || {};
  const specs = {};
  for (const col of columns) specs[col] = capWithDb(explicit[col] || inferSpec(col), table, col);
  return specs;
}

/** Susun skema Zod untuk satu mode. */
function schemaFor(specs, columns, mode) {
  const shape = {};
  for (const col of columns) {
    const spec = specs[col];
    let s;
    switch (spec.tipe) {
      case 'integer': {
        s = z.number().int();
        if (spec.min !== undefined) s = s.min(spec.min);
        if (spec.max !== undefined) s = s.max(spec.max);
        break;
      }
      case 'number': {
        s = z.number();
        // minInclusive/maxInclusive = false → batas terbuka (gt/lt): dipakai kolom
        // dengan CHECK `> 0` (mis. mejas.kapasitas_penampung_l) supaya 0/-5 ditolak
        // 422 DI APLIKASI, bukan jatuh ke error CHECK PostgreSQL (500).
        if (spec.min !== undefined) s = spec.minInclusive === false ? s.gt(spec.min) : s.min(spec.min);
        if (spec.max !== undefined) s = spec.maxInclusive === false ? s.lt(spec.max) : s.max(spec.max);
        break;
      }
      case 'enum':
        s = z.enum(spec.enum);
        break;
      case 'date': {
        // Urutan pesan 422 dipertahankan PERSIS seperti tipe 'string' lama:
        // panjang dicek lebih dulu, dan cek format hanya dijalankan bila panjang
        // lolos — tanpa ini, teks 600 karakter menghasilkan DUA pesan (maksimal
        // 500 karakter + format) padahal sebelumnya hanya SATU (regresi byte 422).
        const minLen = spec.minLen ?? 1;
        const maxLen = spec.maxLen ?? DEFAULT_STR_MAX;
        const formatOk = (v) => typeof v !== 'string'
          || v.length < minLen || v.length > maxLen   // gagal panjang → biar Zod yang bicara
          || (DATE_RE.test(v) && isDateString(v));
        s = z.string().min(minLen).max(maxLen).refine(formatOk);
        break;
      }
      case 'string':
      default:
        s = z.string().min(spec.minLen ?? 1).max(spec.maxLen ?? DEFAULT_STR_MAX)
          // Tolak byte NUL (0x00): lolos validasi lalu PostgreSQL melempar
          // 'invalid byte sequence for encoding "UTF8": 0x00' → 500 (temuan
          // debugging: POST /meja {"meja":"PROBE\u0000"} & PUT /konfigurasi-dosis).
          .refine((v) => !v.includes('\u0000'));
        break;
    }
    // Spec nullable: kolom DB is_nullable=YES (mis. timing_operasi.nilai) — null
    // harus DITERIMA (dulu ditolak 422 keliru sehingga kolom tak bisa dikosongkan
    // lewat API). Kolom non-nullable TETAP menolak null dgn pesan lama
    // 'Kolom X tidak boleh null.' (lihat messageFor).
    if (spec.nullable) s = s.nullable();
    // UPDATE: semua opsional (tipe/panjang tetap dicek bila dikirim).
    shape[col] = mode === 'create' && spec.requiredCreate ? s : s.optional();
  }
  // Object non-strict: field di luar whitelist di-strip dari hasil parse TANPA error —
  // pembuangannya tetap urusan console.warn di handler (perilaku lama dipertahankan).
  return z.object(shape);
}

/** Pesan Indonesia per issue — tidak pernah membocorkan pesan bawaan Zod (Inggris). */
function messageFor(issue, spec, field, value) {
  if (value === undefined) return `Kolom ${field} wajib diisi.`;
  if (value === null) return `Kolom ${field} tidak boleh null.`;
  switch (spec.tipe) {
    case 'string':
      // Issue custom pada string = rafine NUL (0x00) di schemaFor — pesan Zod
      // asli (Inggris) tidak pernah dipakai; ganti dgn pesan Indonesia ini.
      if (issue.code === 'custom') return `Kolom ${field} tidak boleh mengandung karakter terlarang.`;
      if (issue.code === 'too_big') return `Kolom ${field} maksimal ${spec.maxLen ?? DEFAULT_STR_MAX} karakter.`;
      if (issue.code === 'too_small') {
        return (spec.minLen ?? 1) > 1
          ? `Kolom ${field} minimal ${spec.minLen} karakter.`
          : `Kolom ${field} wajib diisi.`;
      }
      return `Kolom ${field} harus berupa teks.`;
    case 'integer':
      if (issue.code === 'too_small' || issue.code === 'too_big') {
        return `Kolom ${field} harus antara ${spec.min ?? '-∞'} dan ${spec.max ?? '∞'}.`;
      }
      return `Kolom ${field} harus berupa bilangan bulat.`;
    case 'number':
      if (issue.code === 'too_small' && spec.minInclusive === false) {
        return `Kolom ${field} harus lebih besar dari ${spec.min}.`;
      }
      if (issue.code === 'too_big' && spec.maxInclusive === false) {
        return `Kolom ${field} harus lebih kecil dari ${spec.max}.`;
      }
      if (issue.code === 'too_small' || issue.code === 'too_big') {
        return `Kolom ${field} harus antara ${spec.min ?? '-∞'} dan ${spec.max ?? '∞'}.`;
      }
      return `Kolom ${field} harus berupa angka.`;
    case 'enum':
      return `Kolom ${field} harus salah satu dari: ${spec.enum.join(', ')}.`;
    case 'date': {
      // urutan sama dengan tipe 'string' supaya pesan lama identik:
      // teks kepanjangan / terlalu pendek → pesan panjang; selain itu format.
      if (issue.code === 'too_big') return `Kolom ${field} maksimal ${spec.maxLen ?? DEFAULT_STR_MAX} karakter.`;
      if (issue.code === 'too_small') {
        return (spec.minLen ?? 1) > 1
          ? `Kolom ${field} minimal ${spec.minLen} karakter.`
          : `Kolom ${field} wajib diisi.`;
      }
      if (typeof value !== 'string') return `Kolom ${field} harus berupa teks.`; // dulu pesan tipe 'string'
      return `Kolom ${field} harus berformat YYYY-MM-DD.`;
    }
    default:
      return `Kolom ${field} tidak valid.`;
  }
}

/**
 * Susun {field: [pesan]} dari issue Zod — format 422 kontrak.
 * Path kosong = body sendiri bukan objek (null/array/teks/angka) → kunci 'body'.
 */
function formatErrors(issues, data, specs) {
  const errors = {};
  for (const issue of issues) {
    const field = issue.path.length ? String(issue.path[0]) : 'body';
    let msg;
    if (!issue.path.length) {
      msg = MSG_BODY;
    } else {
      const spec = specs[field] || inferSpec(field);
      const value = data && typeof data === 'object' && !Array.isArray(data) ? data[field] : undefined;
      msg = messageFor(issue, spec, field, value);
    }
    const list = errors[field] || (errors[field] = []);
    if (!list.includes(msg)) list.push(msg);
  }
  return errors;
}

/**
 * Balasan 422 seragam untuk body yang bukan objek JSON.
 * Dipakai bersama oleh middleware validasi dan penanganan error body-parser di
 * src/index.js (body JSON berupa skalar), supaya bentuknya selalu sama.
 */
const invalidBody = (res) => res.status(422).json({ message: 'Data tidak valid.', errors: { body: [MSG_BODY] } });

/**
 * Middleware validasi body untuk satu rute CRUD.
 * @param {{table: string, columns: string[], mode: 'create'|'update'}} opts
 * @returns {(req: import('express').Request, res: import('express').Response, next: Function) => void}
 */
function validateBody({ table, columns, mode }) {
  // Skema dibangun LAZY pada request pertama (bukan saat modul dimuat) karena peta
  // information_schema baru tersedia setelah startup async; hasilnya di-cache per
  // (tabel, mode) dan dibangun ulang otomatis bila peta dimuat ulang (lengthGen naik).
  // Tanpa cache ini Zod akan menyusun skema di setiap request.
  let built;
  return function validate(req, res, next) {
    if (!built || built.gen !== lengthGen) {
      const specs = specsFor(table, columns);
      built = { gen: lengthGen, specs, schema: schemaFor(specs, columns, mode) };
    }
    const { specs, schema } = built;
    // body bisa undefined (tanpa content-type) → perlakukan sebagai objek kosong;
    // null/array/teks/angka tetap ditolak lewat issue path kosong ('body').
    const body = req.body === undefined ? {} : req.body;
    const result = schema.safeParse(body);
    if (result.success) return next();
    return res.status(422).json({ message: 'Data tidak valid.', errors: formatErrors(result.error.issues, body, specs) });
  };
}

module.exports = {
  validateBody, invalidBody, inferSpec, specsFor, loadColumnLengths,
  TABLE_SPECS, MSG_BODY, INT4_MIN, INT4_MAX, DATE_RE, isDateString, isQueryDate,
  tanggalErrors,
};
