'use strict';
/**
 * Penjadwal analisis AI harian: tiap 07.00 WIB (UTC+7 tetap, Indonesia tanpa DST).
 * Saat boot: bila sudah ≥ 07.00 WIB dan laporan hari ini belum ada → jalankan sekali (kejar ketinggalan).
 * Mati bila AI_ANALISIS_HARIAN=0. Tidak menyentuh aktuator: hanya menyusun laporan dan menyimpannya.
 */
const WIB_MS = 7 * 3600_000;
const JAM = 7;
const HARI_MS = 86_400_000;

/** Tanggal WIB 'YYYY-MM-DD' untuk saat `ms`. */
const tanggalWib = (ms = Date.now()) => new Date(ms + WIB_MS).toISOString().slice(0, 10);

/** Milidetik sampai 07.00 WIB berikutnya (selalu > 0). */
function msSampai07Wib(ms = Date.now()) {
  const sejakTengahMalamWib = (ms + WIB_MS) % HARI_MS;
  const target = JAM * 3600_000;
  return sejakTengahMalamWib < target ? target - sejakTengahMalamWib : HARI_MS - sejakTengahMalamWib + target;
}

const sudahLewat07 = (ms = Date.now()) => (ms + WIB_MS) % HARI_MS >= JAM * 3600_000;

let berjalan = null;
let timer = null;

/** Susun + simpan laporan untuk tanggal WIB sekarang. Panggilan bersamaan → galat SEDANG_BERJALAN. */
async function jalankanSekarang({ pemicu = 'jadwal', oleh = null } = {}) {
  if (berjalan) {
    const e = new Error('Analisis harian sedang berjalan.');
    e.code = 'SEDANG_BERJALAN';
    throw e;
  }
  berjalan = (async () => {
    const tanggal = tanggalWib();
    const isi = await require('./aiAnalisisHarian').kumpulDanSusun(tanggal);
    return require('./analisisHarianRepo').simpan({ tanggal, pemicu, oleh, isi });
  })();
  try { return await berjalan; } finally { berjalan = null; }
}

const sedangBerjalan = () => !!berjalan;

function jadwalkan() {
  timer = setTimeout(() => {
    jalankanSekarang()
      .then((r) => console.log(`[ANALISIS HARIAN] tersimpan ${r.tanggal}`))
      .catch((e) => console.error('[ANALISIS HARIAN] gagal:', e.message))
      .finally(jadwalkan);
  }, msSampai07Wib());
  if (timer.unref) timer.unref();
}

async function mulai() {
  if (process.env.AI_ANALISIS_HARIAN === '0') return false;
  console.log('Analisis AI harian : AKTIF (07.00 WIB)');
  jadwalkan();
  if (sudahLewat07() && !(await require('./analisisHarianRepo').adaUntuk(tanggalWib()))) {
    jalankanSekarang().catch((e) => console.error('[ANALISIS HARIAN] kejar ketinggalan gagal:', e.message));
  }
  return true;
}

function henti() { if (timer) clearTimeout(timer); timer = null; }

module.exports = { tanggalWib, msSampai07Wib, sudahLewat07, jalankanSekarang, sedangBerjalan, mulai, henti };
