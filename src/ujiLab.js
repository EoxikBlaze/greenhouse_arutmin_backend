'use strict';
/** Spesifikasi parameter Uji Lab hasil panen per kategori (Buah / Sayur). Melon = Buah (bawaan). */
const PARAMETER = {
  buah: {
    ph: { nama: 'pH', satuan: '', min: 0, max: 14 },
    ec_ppm: { nama: 'EC / PPM', satuan: 'ppm', min: 0, max: 10000 },
    brix: { nama: 'Brix (kemanisan)', satuan: '°Brix', min: 0, max: 40 },
    diameter_cm: { nama: 'Ukuran (diameter)', satuan: 'cm', min: 0, max: 100 },
    bobot_g: { nama: 'Bobot', satuan: 'g', min: 0, max: 50000 },
  },
  sayur: {
    ph: { nama: 'pH', satuan: '', min: 0, max: 14 },
    ec_ppm: { nama: 'EC / PPM', satuan: 'ppm', min: 0, max: 10000 },
    bobot_g: { nama: 'Bobot', satuan: 'g', min: 0, max: 50000 },
    tinggi_cm: { nama: 'Tinggi tanaman', satuan: 'cm', min: 0, max: 300 },
    jumlah_daun: { nama: 'Jumlah daun', satuan: 'helai', min: 0, max: 1000 },
    nitrat_ppm: { nama: 'Kadar nitrat', satuan: 'ppm', min: 0, max: 20000 },
  },
};
const KATEGORI = Object.keys(PARAMETER);

/** Validasi murni satu permintaan POST. Mengembalikan {ok, errors} atau {ok, kategori, tanggal, baris[]}. */
function validasi(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const err = {};
  const kategori = b.kategori;
  if (!KATEGORI.includes(kategori)) err.kategori = ['kategori harus buah atau sayur.'];
  let tanggal = b.tanggal;
  if (tanggal === undefined || tanggal === null || tanggal === '') tanggal = null;
  else if (typeof tanggal !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(tanggal) || new Date(`${tanggal}T00:00:00Z`).toISOString().slice(0, 10) !== tanggal) err.tanggal = ['tanggal harus berformat YYYY-MM-DD.'];
  let idSiklus = null;
  if (b.id_siklus_budidaya !== undefined && b.id_siklus_budidaya !== null && b.id_siklus_budidaya !== '') {
    idSiklus = Number(b.id_siklus_budidaya);
    if (!Number.isInteger(idSiklus) || idSiklus < 1) err.id_siklus_budidaya = ['id_siklus_budidaya harus id angka.'];
  }
  if (b.catatan !== undefined && b.catatan !== null && (typeof b.catatan !== 'string' || b.catatan.length > 500)) err.catatan = ['catatan maksimal 500 karakter.'];
  const daftar = Array.isArray(b.hasil) ? b.hasil : b.parameter !== undefined ? [{ parameter: b.parameter, nilai: b.nilai }] : [];
  if (!daftar.length) err.hasil = ['isi minimal satu parameter.'];
  if (daftar.length > 20) err.hasil = ['maksimal 20 parameter sekali kirim.'];
  const baris = [];
  if (KATEGORI.includes(kategori) && daftar.length <= 20) {
    const dipakai = new Set();
    for (const h of daftar) {
      const spec = PARAMETER[kategori][h && h.parameter];
      if (!spec) { err.hasil = [`parameter "${h && h.parameter}" tidak dikenal untuk ${kategori}.`]; break; }
      if (dipakai.has(h.parameter)) { err.hasil = [`parameter ${h.parameter} dobel.`]; break; }
      dipakai.add(h.parameter);
      const n = typeof h.nilai === 'number' ? h.nilai : typeof h.nilai === 'string' && h.nilai.trim() !== '' ? Number(h.nilai.replace(',', '.')) : NaN;
      if (!Number.isFinite(n) || n < spec.min || n > spec.max) { err.hasil = [`${spec.nama} harus angka ${spec.min}–${spec.max}.`]; break; }
      baris.push({ parameter: h.parameter, nilai: n, satuan: spec.satuan });
    }
  }
  if (Object.keys(err).length) return { ok: false, errors: err };
  return { ok: true, kategori, tanggal, id_siklus_budidaya: idSiklus, catatan: b.catatan || null, baris };
}

module.exports = { PARAMETER, KATEGORI, validasi };
