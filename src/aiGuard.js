'use strict';
/**
 * PENGAMAN ASISTEN AI — berlapis, tanpa bergantung pada kepatuhan model.
 *
 *  L1  normalisasi      : NFKC, buang karakter tak terlihat/bidi, lipat homoglif
 *                         (Cyrillic/Yunani → Latin) dan leetspeak, rapatkan spasi.
 *  L2  deteksi injeksi  : pola ID + EN pada beberapa varian teks (normal, tanpa
 *                         spasi/tanda baca, hasil decode base64/hex/rot13).
 *  L3  gerbang topik    : pesan di luar hidroponik/GARAP tidak sampai ke LLM.
 *  L4  anti-brute-force : strike per pengguna → jeda otomatis.
 *  L5  isolasi prompt   : pesan pengguna dibungkus tag, `<` `>` dinetralkan;
 *                         riwayat & data DB disaring ulang (bisa dipalsukan klien).
 *  L6  canary + saringan keluaran : bocoran prompt/rahasia/tautan keluar dibuang.
 *
 * Semua fungsi murni (kecuali strike) supaya mudah diuji.
 */
const crypto = require('crypto');

/** Penanda rahasia per proses; bila muncul di jawaban → prompt bocor. */
const CANARY = `GRP-${crypto.randomBytes(6).toString('hex')}`;

/* ── L1 normalisasi ──────────────────────────────────────────────────── */
const HOMOGLIF = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', һ: 'h', к: 'k', м: 'm', т: 't', в: 'b', н: 'h',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ο: 'o', ρ: 'p', τ: 't', υ: 'u', ν: 'v', χ: 'x', η: 'n',
};
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i', '|': 'i' };
// zero-width, BOM, kontrol bidi, soft hyphen, tag characters
const TAK_TERLIHAT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]|\uDB40[\uDC00-\uDFFF]/g;

function normalisasi(teks) {
  let s = String(teks == null ? '' : teks);
  try { s = s.normalize('NFKC'); } catch { /* biarkan */ }
  s = s.replace(TAK_TERLIHAT, '');
  s = s.replace(/[̀-ͯ]/g, '');                // diakritik bertumpuk
  s = s.toLowerCase();
  s = Array.from(s).map((c) => HOMOGLIF[c] || c).join('');
  return s.replace(/\s+/g, ' ').trim();
}
const lipatLeet = (s) => Array.from(s).map((c) => LEET[c] || c).join('');
const rapat = (s) => s.replace(/[^a-z0-9]+/g, '');      // "i g n o r e" → "ignore"

/** Coba buka muatan tersandi (base64 / hex / rot13) → teks tambahan untuk diperiksa. */
function dekodeTersembunyi(s) {
  const out = [];
  for (const m of s.match(/[a-z0-9+/_-]{12,}={0,2}/gi) || []) {
    try {
      const t = Buffer.from(m.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (/^[\x20-\x7E\s]{6,}$/.test(t)) out.push(normalisasi(t));
    } catch { /* bukan base64 */ }
  }
  for (const m of s.match(/(?:[0-9a-f]{2}){12,}/gi) || []) {
    try {
      const t = Buffer.from(m, 'hex').toString('utf8');
      if (/^[\x20-\x7E\s]{6,}$/.test(t)) out.push(normalisasi(t));
    } catch { /* bukan hex */ }
  }
  if (/rot-?13|caesar|decode (this|ini)|dekode|terjemahkan sandi/i.test(s)) {
    out.push(s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97)));
  }
  return out;
}

/* ── L2 pola injeksi ─────────────────────────────────────────────────── */
const KATA_SEBELUM = '(?:semua|seluruh|all|any|previous|prior|above|earlier|sebelum\\w*|di ?atas|tadi|lama|awal|the|your|kamu|mu|anda)';
const POLA = [
  // menimpa instruksi
  ['override', new RegExp(`\\b(?:ignore|disregard|forget|override|bypass|abaikan|lupakan|hiraukan|kesampingkan|timpa|lewati|batalkan|hapus)\\b.{0,40}\\b(?:instruction|instruksi|rule|aturan|prompt|perintah|directive|guideline|pedoman|batasan|restriction|konteks|context|sistem|system|filter|safety|pengaman)`) ],
  ['override', new RegExp(`\\b(?:ignore|disregard|forget|abaikan|lupakan)\\b.{0,25}${KATA_SEBELUM}`)],
  ['override', /\b(?:new|baru|updated?|revisi)\s+(?:instruction|instruksi|rule|aturan|prompt|perintah)s?\b/],
  ['override', /\b(?:mulai sekarang|from now on|starting now|mulai saat ini)\b.{0,60}\b(?:kamu|anda|you|jawab|answer|respond|selalu|always)\b/],
  // bocorkan prompt
  ['bocor_prompt', /\b(?:system|sistem|developer|pengembang|hidden|tersembunyi|initial|awal|internal|original|asli)\s*(?:prompt|message|pesan|instruction|instruksi|rule|aturan)s?\b/],
  ['bocor_prompt', /\b(?:reveal|show|print|repeat|display|leak|dump|recite|output|tampilkan|tunjukkan|bocorkan|ulangi|ulang|sebutkan|cetak|tuliskan|salin|copy|bacakan|beritahu|katakan)\b.{0,40}\b(?:prompt|instruksi|instruction|aturan|rules?|konfigurasi|configuration|pengaturan awal|tag data|isi data|kata[- ]kata di atas|text above|words above)/],
  ['bocor_prompt', /\b(?:what|apa)\b.{0,15}\b(?:your|kamu|anda|mu)\b.{0,20}\b(?:instruction|instruksi|rule|aturan|prompt|programmed|diprogram|dilarang|forbidden)/],
  ['bocor_prompt', /\bcanary\b|\bgrp-[0-9a-f]{6,}/],
  // pembajakan peran
  ['bajak_peran', /\b(?:you are now|you're now|kamu (?:sekarang|kini|adalah)|anda (?:sekarang|kini)|sekarang kamu|mulai sekarang kamu|act as|bertindaklah|bertingkahlah|berperanlah|pretend|pura[- ]?pura|berpura|roleplay|role[- ]play|bermain peran|simulasikan|simulate|imagine you|bayangkan kamu|anggap (?:saja )?kamu|seolah[- ]olah)\b/],
  ['bajak_peran', /\b(?:dan mode|mode dan|d\.a\.n|do anything now|jailbreak\w*|jail ?break|developer mode|mode developer|god mode|mode dewa|sudo mode|admin mode|mode admin|unrestricted|uncensored|tanpa sensor|tanpa batas\w*|tanpa filter|tanpa aturan|no (?:rules|restrictions|limits|filter)|bebas (?:aturan|batasan)|mode bebas|evil mode|opposite mode|devmode)\b/],
  ['bajak_peran', /\b(?:aku|saya|i)\s+(?:adalah|am|is)\s+(?:admin|administrator|developer|pengembang|pembuat|owner|pemilik|anthropic|openai|root|superuser)\b/],
  ['bajak_peran', /\b(?:izin|permission|akses|access|otoritas|authorization)\s+(?:khusus|admin|root|tertinggi|penuh|elevated|override)\b/],
  // delimiter / format palsu
  ['delimiter', /<\|?\s*(?:im_start|im_end|system|assistant|user|endoftext|eot_id|start_header_id)\b|\[\/?inst\]|<<\/?sys>>|<\/?(?:system|instruction|prompt|data|pesan_pengguna|admin|rules?)\b[^>]*>/],
  ['delimiter', /(?:^|\n|\s)(?:#{1,4}\s*)?(?:system|assistant|sistem|developer|asisten)\s*(?:prompt)?\s*[:>]\s/],
  ['delimiter', /\b(?:end of (?:the )?(?:prompt|instructions?|data)|akhir (?:dari )?(?:prompt|instruksi|data)|---+\s*(?:system|new|baru)|=== ?(?:system|new))/],
  // rahasia
  ['rahasia', /\b(?:api[ _-]?key|apikey|secret|jwt|bearer|token|credential|kredensial|private key|kunci (?:api|rahasia|privat)|connection string|database[ _-]?url|\.env|env var|variabel lingkungan|bcrypt|ssh|ghp_|sk-[a-z0-9])/],
  ['rahasia', /\b(?:tampilkan|tunjukkan|bocorkan|beri\w*|kasih\w*|sebutkan|kirim\w*|show|reveal|give|tell|leak|dump|print|apa|what(?:'s| is)?)\b.{0,30}\b(?:password|passwd|kata ?sandi|sandi|hash)\b/],
  ['rahasia', /\b(?:esp32[ _-]?api[ _-]?key|jwt[ _-]?secret|db[ _-]?pass\w*|postgres(?:ql)?:\/\/)/],
  // kode / SQL / shell
  ['kode', /\b(?:drop|truncate|alter|delete|insert|update|grant|revoke)\s+(?:table|database|from|into|user|role|schema|\*)|\bunion\s+(?:all\s+)?select\b|\bselect\b.{1,40}\bfrom\b|;\s*--|\bor\s+1\s*=\s*1\b|\bpg_sleep\b|information_schema|pg_catalog/],
  ['kode', /\b(?:rm\s+-rf|curl\s+|wget\s+|chmod\s|sudo\s|\/etc\/passwd|\/bin\/(?:ba)?sh|powershell|cmd\.exe|eval\s*\(|exec\s*\(|child_process|require\s*\(|import\s+os|__import__|subprocess|document\.cookie|<script|javascript:|onerror\s*=|onload\s*=|\$\{|\{\{)/],
  // keluar-data via tautan/gambar
  ['eksfiltrasi', /!\[[^\]]*\]\(|\bhttps?:\/\/\S+\?\S*=|\b(?:kirim|send|post|forward|upload)\b.{0,30}\b(?:ke|to)\b.{0,15}(?:https?:|www\.|\w+@\w+)/],
  // perintah kontrol perangkat lewat chat
  ['kontrol', /\b(?:nyalakan|hidupkan|matikan|aktifkan|nonaktifkan|reset|unlock|buka kunci|lepas kunci|hapus|kosongkan|turn (?:on|off)|enable|disable|force|paksa|override)\b.{0,25}\b(?:pompa|katup|valve|solenoid|dosing|dosis|lock|kunci|e-?stop|relay|aerator|semua|seluruh|data|alert|log|akun|user|pengguna)/],
];

/** Kategori yang SELALU diblokir. `kontrol` hanya ditolak dengan arahan, tanpa strike. */
const TANPA_STRIKE = new Set(['kontrol']);

/** Pola untuk varian TANPA spasi/tanda baca ("i g n o r e" → "ignore"). */
const POLA_RAPAT = [
  ['override', /(?:ignore|abaikan|lupakan|disregard|forget)(?:all|semua|seluruh|previous|prior|your|the|instruksi|instructions?|aturan|rules?)/],
  ['bocor_prompt', /(?:systemprompt|promptsistem|instruksisistem|initialprompt|hiddenprompt|developermessage)/],
  ['bajak_peran', /(?:jailbreak|developermode|youarenow|kamusekarang|donotfollow|actas|pura?pura)/],
  ['bajak_peran', /(?:sayaadalah|akuadalah|saya|aku|iam|imthe)(?:admin|administrator|developer|pengembang|owner|pemilik|root|superuser)/],
  ['rahasia', /(?:apikey|jwtsecret|databaseurl|secretkey|privatekey|katasandiadmin|envfile|fileenv|connectionstring)/],
  ['kode', /(?:droptable|unionselect|selectfrom|rmrf|ororfs)/],
];

function deteksi(pesan) {
  const dasar = normalisasi(pesan);
  const biasa = new Set([dasar, lipatLeet(dasar)]);
  const kompak = new Set([rapat(dasar), rapat(lipatLeet(dasar))]);
  for (const d of dekodeTersembunyi(String(pesan || ''))) { biasa.add(d); kompak.add(rapat(d)); }

  const kategori = new Set();
  for (const v of biasa) {
    for (const [nama, re] of POLA) if (re.test(v)) kategori.add(nama);
  }
  for (const v of kompak) {
    for (const [nama, re] of POLA_RAPAT) if (re.test(v)) kategori.add(nama);
  }
  // "acak": token sangat panjang / rasio simbol tinggi / pengulangan karakter
  const mentah = String(pesan || '');
  const huruf = (mentah.match(/[a-zA-Z]/g) || []).length;
  const simbol = (mentah.match(/[^\p{L}\p{N}\s.,?!'"():%/+\-°]/gu) || []).length;
  const tokenPanjang = (mentah.match(/\S{50,}/g) || []).length > 0;
  const ulang = /(.)\1{15,}/.test(mentah) || /(\b\w{2,12}\b)(?:\s+\1){6,}/i.test(mentah);
  if (mentah.length > 20 && (simbol / Math.max(1, mentah.length) > 0.3 || (huruf / Math.max(1, mentah.length) < 0.35) || tokenPanjang || ulang)) {
    kategori.add('acak');
  }
  return [...kategori];
}

/* ── L3 gerbang topik ────────────────────────────────────────────────── */
const KATA_TOPIK = [
  'ph', 'tds', 'ppm', 'ec', 'suhu', 'nutrisi', 'larutan', 'air', 'tahap', 'semai', 'peremajaan', 'pendewasaan',
  'tanam', 'panen', 'alert', 'peringatan', 'katup', 'kelembapan', 'siklus', 'hidroponik', 'budidaya', 'tanaman',
  'meja', 'sensor', 'ambang', 'aerasi', 'pompa', 'aliran', 'cahaya', 'lampu', 'akar', 'daun', 'selada', 'pakcoy',
  'sawi', 'kangkung', 'bayam', 'nft', 'dft', 'greenhouse', 'rumah kaca', 'penampung', 'dosis', 'dosing', 'lock',
  'pemeliharaan', 'esp32', 'cctv', 'kamera', 'garap', 'vertonik', 'aplikasi', 'dashboard', 'riwayat', 'laporan',
  'diagnosa', 'diagnosis', 'debug', 'periksa', 'cek', 'status', 'tabel', 'kondisi', 'error',
  'offline', 'online', 'koneksi', 'bantuan', 'help', 'fitur', 'menu', 'halaman', 'login', 'akun', 'saran', 'rekomendasi', 'ringkas', 'ringkasan', 'grafik',
  'nutrient', 'water', 'stage', 'harvest', 'humidity', 'temperature', 'plant', 'status',
];
const SAPAAN = /^(?:h(?:a)?i|halo|hai|hello|hey|pagi|siang|sore|malam|selamat \w+|terima ?kasih|makasih|thanks?|ok(?:e|ay)?|siap|baik|mantap|tolong|bantu|help|siapa kamu|kamu siapa|apa (?:itu|yang bisa) .*)[\s.!?]*$/;

function dalamTopik(pesan, adaRiwayat) {
  const s = normalisasi(pesan);
  if (SAPAAN.test(s)) return true;
  const kata = new Set(s.split(/[^a-z0-9]+/).filter(Boolean));
  for (const k of KATA_TOPIK) {
    if (k.includes(' ') ? s.includes(k) : kata.has(k)) return true;
  }
  // lanjutan singkat ("kenapa begitu?") hanya bila sudah ada percakapan
  return Boolean(adaRiwayat) && s.length <= 40;
}

/* ── L4 strike per pengguna ──────────────────────────────────────────── */
const strikes = new Map(); // kunci → { n, sejak, sampai }
const JENDELA_MS = 10 * 60_000;
const BATAS_STRIKE = 4;
const JEDA_MS = 5 * 60_000;
const kunci = (u) => String((u && (u.id || u.sub || u.username)) || 'anon');

function sisaJeda(user, now = Date.now()) {
  const s = strikes.get(kunci(user));
  return s && s.sampai > now ? Math.ceil((s.sampai - now) / 1000) : 0;
}
function catatPelanggaran(user, now = Date.now()) {
  const k = kunci(user);
  let s = strikes.get(k);
  if (!s || now - s.sejak > JENDELA_MS) s = { n: 0, sejak: now, sampai: 0 };
  s.n += 1;
  if (s.n >= BATAS_STRIKE) { s.sampai = now + JEDA_MS; s.n = 0; s.sejak = now; }
  strikes.set(k, s);
  if (strikes.size > 5000) for (const [kk, v] of strikes) if (v.sampai < now && now - v.sejak > JENDELA_MS) strikes.delete(kk);
  return s;
}
function resetStrike() { strikes.clear(); }

/* ── penolakan (variasi supaya tidak bisa dijadikan oracle) ──────────── */
const TOLAK = {
  injeksi: [
    'Saya tidak bisa memproses permintaan itu. Saya hanya membantu soal hidroponik dan penggunaan GARAP — mau saya cek kondisi pH dan TDS sekarang?',
    'Permintaan itu di luar yang boleh saya kerjakan. Coba tanyakan soal sensor, tanaman, alert, atau minta "diagnosa menyeluruh".',
    'Maaf, aturan kerja saya tidak bisa diubah lewat percakapan. Saya siap membantu membaca data greenhouse Anda.',
  ],
  topik: [
    'Pertanyaan itu di luar bidang saya. Saya hanya membahas hidroponik, sensor, tanaman, dan aplikasi GARAP.',
    'Saya khusus untuk budidaya hidroponik dan sistem GARAP. Coba tanya kondisi sensor, alert, atau tahap tanam.',
  ],
  kontrol: [
    'Saya tidak mengendalikan alat dari chat. Gunakan halaman Kontrol Air/Penampung di aplikasi — saya bisa membantu memeriksa kondisinya lebih dulu.',
  ],
  acak: [
    'Pesan itu tidak terbaca sebagai pertanyaan. Tulis ulang dengan kalimat biasa, misalnya "bagaimana pH dan TDS sekarang?".',
  ],
  jeda: [
    'Terlalu banyak permintaan yang ditolak. Asisten dijeda sementara — coba lagi beberapa menit lagi.',
  ],
};
function pesanTolak(jenis) {
  const a = TOLAK[jenis] || TOLAK.injeksi;
  return a[crypto.randomInt(a.length)];
}

/**
 * Periksa pesan pengguna. → { ok:true } atau { ok:false, jenis, kategori[] }.
 * `riwayatAda`: percakapan sudah berjalan (mengizinkan lanjutan singkat).
 */
function periksaPesan(pesan, { riwayatAda = false } = {}) {
  const kategori = deteksi(pesan);
  if (kategori.includes('kontrol') && kategori.length === 1) return { ok: false, jenis: 'kontrol', kategori };
  const berbahaya = kategori.filter((k) => !TANPA_STRIKE.has(k));
  if (berbahaya.length) {
    return { ok: false, jenis: berbahaya.includes('acak') && berbahaya.length === 1 ? 'acak' : 'injeksi', kategori: berbahaya };
  }
  if (!dalamTopik(pesan, riwayatAda)) return { ok: false, jenis: 'topik', kategori: ['luar_topik'] };
  return { ok: true, kategori: [] };
}

/* ── L5 isolasi ──────────────────────────────────────────────────────── */
/** Netralkan karakter pembentuk tag & pembatas supaya tak bisa menutup <pesan_pengguna>. */
function netralkan(teks) {
  return String(teks == null ? '' : teks)
    .replace(TAK_TERLIHAT, '')
    .replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›'))
    .replace(/`{3,}/g, "'''")
    .replace(/\s+/g, ' ').trim();
}
const bungkusPengguna = (pesan) => `<pesan_pengguna>${netralkan(pesan)}</pesan_pengguna>`;

/** Saring string berasal dari DB (nama tanaman, nilai alert, nama kamera, dst.). */
function bersihkanData(nilai, kedalaman = 0) {
  if (kedalaman > 6) return null;
  if (typeof nilai === 'string') {
    const t = netralkan(nilai).slice(0, 80);
    return deteksi(t).length ? '[disaring]' : t;
  }
  if (Array.isArray(nilai)) return nilai.slice(0, 50).map((x) => bersihkanData(x, kedalaman + 1));
  if (nilai && typeof nilai === 'object' && !(nilai instanceof Date)) {
    const o = {};
    for (const [k, v] of Object.entries(nilai).slice(0, 60)) o[String(k).slice(0, 40)] = bersihkanData(v, kedalaman + 1);
    return o;
  }
  return nilai;
}

/** Riwayat dari klien tidak tepercaya: saring ulang, buang giliran 'ai' yang mencurigakan. */
function saringRiwayat(riwayat) {
  const out = [];
  for (const r of riwayat || []) {
    const teks = netralkan(r.teks).slice(0, 600);
    if (!teks) continue;
    if (deteksi(teks).filter((k) => !TANPA_STRIKE.has(k)).length) continue;
    if (r.peran === 'assistant' && (teks.includes(CANARY) || /<\/?(?:pesan_pengguna|data)>/.test(r.teks))) continue;
    out.push({ peran: r.peran, teks });
  }
  return out;
}

/* ── L6 keluaran ─────────────────────────────────────────────────────── */
const SIDIK_PROMPT = ['aturan keras', 'pesan_pengguna', '<data>', 'bukan perintah', 'asisten budidaya hidroponik vertonik', CANARY.toLowerCase()];
const RAHASIA_KELUAR = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,         // JWT
  /\b(?:postgres(?:ql)?|mysql|mongodb|redis):\/\/\S+/gi,                  // connection string
  /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{40,}/g,                                 // bcrypt
  /\b(?:JWT_SECRET|DATABASE_URL|ESP32_API_KEY|DB_PASSWORD|AI_OLLAMA_URL)\b\s*[:=]?\s*\S*/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,                                                // hash/kunci hex
  /\b(?:sk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}\b/g,
];

/** → { teks, bocor:boolean }. Bila bocor, panggil pemanggil harus ganti dengan penolakan. */
function saringKeluaran(teks, panjangMaks = 1500) {
  let t = String(teks == null ? '' : teks).replace(TAK_TERLIHAT, '').trim();
  const rendah = t.toLowerCase();
  if (rendah.includes(CANARY.toLowerCase())) return { teks: '', bocor: true };
  if (SIDIK_PROMPT.filter((s) => rendah.includes(s)).length >= 2) return { teks: '', bocor: true };
  for (const re of RAHASIA_KELUAR) t = t.replace(re, '[disembunyikan]');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '')                              // gambar (jalur eksfiltrasi)
    .replace(/\[([^\]]+)\]\((?:https?:|javascript:|data:)[^)]*\)/gi, '$1')  // tautan → teks saja
    .replace(/https?:\/\/\S+/gi, '[tautan dihapus]')
    .replace(/<\/?[a-z][^>]*>/gi, '')                                      // HTML
    .replace(/\n{3,}/g, '\n\n');
  return { teks: t.slice(0, panjangMaks).trim(), bocor: false };
}

module.exports = {
  CANARY, normalisasi, deteksi, dalamTopik, periksaPesan, pesanTolak,
  sisaJeda, catatPelanggaran, resetStrike,
  netralkan, bungkusPengguna, bersihkanData, saringRiwayat, saringKeluaran,
};
