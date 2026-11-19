'use strict';
/**
 * Modul Pengetahuan Agronomi Khusus Melon Hidroponik GARAP.
 *
 * Menyimpan SOP lapangan spesifik kebun (termasuk teknik perkecambahan air bawang
 * merah -> kain hitam -> aklimatisasi sinar 2 hari -> rockwool), standar nutrisi
 * Mode Naik Harian, Brix, iklim VPD, hama/penyakit, serta kalibrasi IoT MQTT.
 *
 * Dipakai oleh:
 *  1. Injector konteks ringkas Qwen (/api/ai/chat jalur LLM) — hanya menyisipkan
 *     1 potongan relevan (~45–70 token) agar Qwen 1.5B di Raspberry Pi akurat
 *     menjawab sesuai SOP tanpa membebani num_ctx 1024 atau memperlambat CPU.
 *  2. Rujukan tunggal SOP penyemaian melon lapangan.
 */
const { normalisasi } = require('./aiGuard');

const SOP_SEMAI_MELON_LAPANGAN = [
  '1. Perendaman & Seleksi Uji Apung (1 Hari / 24 Jam):',
  '   • Rendam benih melon dalam air larutan perasan/ekstrak bawang merah segar (~4–6 siung bawang merah digeprek/diblender per ±150–250 mililiter air bersih, saring) selama 1 hari (24 jam) di wadah terbuka agar benih tetap mendapat oksigen. Bawang merah mengandung ZPT auksin & giberelin alami serta allisin antijamur untuk memecah dormansi.',
  '   • Uji Seleksi: Benih yang tenggelam menandakan biji bernas (isi padat, embrio sehat) sehingga layak dipakai semai. Benih yang masih mengambang cenderung hampa/kopong dan kemungkinan besar tidak berkecambah (pisahkan).',
  '   • Setelah 24 jam, tiriskan benih yang tenggelam lalu bilas ringan dengan air bersih agar sisa lendir bawang tidak mengundang jamur.',
  '2. Pemeraman di Kain Hitam Lembap (2 Hari / 48 Jam):',
  '   • Letakkan benih terpilih di lipatan kain hitam bersih yang lembap (diperas, tidak tergenang becek), lalu simpan di tempat teduh/gelap selama 2 hari.',
  '   • Kondisi gelap & lembap menstimulasi hormon auksin sehingga cangkang benih pecah dan muncul calon akar putih (kecambah/radikula). Cek tiap 12–24 jam supaya kain tetap lembap.',
  '3. Penjemuran / Aklimatisasi Sinar Bertahap (2 Hari):',
  '   • Setelah berkecambah, lakukan penjemuran selama 2 hari lagi sebelum ditaruh ke rockwool untuk memperkuat bakal batang, membiasakan cahaya, dan mencegah kutilang/etiolasi (batang kurus pucat).',
  '   • Tips aman agar kecambah tidak mati: utamakan sinar matahari pagi (pukul 07.00–10.00 WIB, hindari terik siang >33°C) dan jaga kain alas tetap lembap supaya akar putih halus (radikula) tidak mengering.',
  '4. Pemindahan ke Media Rockwool & Nutrisi Awal:',
  '   • Potong dadu rockwool ±2,5 x 2,5 x 2,5 sentimeter dan basahi air bersih hingga lembap (tidak tergenang).',
  '   • Buat lubang ±0,5–1 sentimeter dan taruh kecambah secara hati-hati dengan ujung akar putih menghadap ke bawah.',
  '   • Setelah daun lembaga (kotiledon) membuka penuh, kenalkan nutrisi semai ringan 400–600 PPM (pH 5,8–6,5) hingga siap pindah tanam (10–14 HSS, 2–4 daun sejati).',
].join('\n');

const MODUL_MELON = [
  {
    id: 'semai_bawang_merah',
    bobotPola: /\b(?:semai|menyemai|bibit|benih|kecambah|bawang merah|kain hitam|mengambang|tenggelam|rockwool|rockwall|jemur)\b/,
    ringkasQwen: 'SOP Semai Melon GARAP: rendam air bawang merah 1 hari (benih tenggelam=pakai, mengambang=hampa/sulit tumbuh, lalu bilas); peram kain hitam lembap gelap 2 hari hingga berkecambah; jemur sinar pagi 2 hari sambil jaga lembap (cegah kutilang/radikula kering); baru pindah ke rockwool (nutrisi awal 400-600 PPM, pH 5.8-6.5 saat daun buka).',
  },
  {
    id: 'pindah_peremajaan',
    bobotPola: /\b(?:pindah tanam|peremajaan|vegetatif|meja tanam|daun sejati|netpot|hss)\b/,
    ringkasQwen: 'Pindah Tanam Melon: umur 10-14 hari setelah semai (2-4 daun sejati). Nutrisi peremajaan/vegetatif 800-1000 PPM, pH 5.8-6.5. Buang tunas air di bawah ruas 8 agar batang utama kokoh.',
  },
  {
    id: 'polinasi_seleksi',
    bobotPola: /\b(?:polinasi|penyerbukan|bunga betina|bunga jantan|seleksi buah|gantung buah|ruas|pangkas|tunas air|toping)\b/,
    ringkasQwen: 'Polinasi Melon: bunga betina ruas 9-12 diserbuki pagi pukul 07.00-10.00 WIB. Pilih 1 buah paling simetris sebesar telur per pohon, gantung buah, dan topping pucuk di daun ke-25-28.',
  },
  {
    id: 'naik_harian_nutrisi',
    bobotPola: /\b(?:naik harian|ab mix|abmix|ppm|ec|tds|dosis|nutrisi|pekat|pematangan|pembesaran)\b/,
    ringkasQwen: 'Nutrisi Melon Mode Naik Harian GARAP: Semai 400-600 PPM, Vegetatif 800-1000 PPM, Pembungaan 1000-1200 PPM, Pembesaran/Netting 1400-1800 PPM, Pematangan (H-10 panen) turun ke 800-1000 PPM. pH ideal 5.8-6.5.',
  },
  {
    id: 'brix_panen',
    bobotPola: /\b(?:brix|manis|gula|panen|matang|netting|jaring|hst|pecah buah|cracking)\b/,
    ringkasQwen: 'Brix & Panen Melon (60-75 HST): target 12-15+ Brix dengan 1 buah/pohon, nutrisi pembesaran dominan Kalium 1400-1800 PPM lalu turun 800-1000 PPM & kurangi air H-7 sebelum petik. Ciri siap panen: net rapat, tangkai retak cincin, aroma harum.',
  },
  {
    id: 'kalibrasi_mqtt_garap',
    bobotPola: /\b(?:kalibrasi|buffer|6\.?86|4\.?01|9\.?18|1413|mqtt|probe|esp32|sensor)\b/,
    ringkasQwen: 'Kalibrasi GARAP via Website+MQTT: menu Kalibrasi -> pH buffer 6.86 & 4.01 (opsional 9.18) tunggu stabil & klik Simpan; EC/TDS pakai larutan 1413 uS/cm (~706 PPM). Probe pH kering direndam KCl 3M dulu.',
  },
  {
    id: 'iklim_vpd_melon',
    bobotPola: /\b(?:suhu|temperatur|kelembap|vpd|panas|dingin|udara|oksigen|aerator|akar)\b/,
    ringkasQwen: 'Iklim Melon Greenhouse: suhu siang 26-32 C, malam 20-24 C, RH vegetatif 65-75%, RH buah 55-65%, VPD 0.8-1.2 kPa, suhu air di penampung ideal 20-26 C (maks 28 C) agar DO tinggi dan akar bebas Pythium.',
  },
  {
    id: 'hama_penyakit_melon',
    bobotPola: /\b(?:hama|penyakit|tungau|thrips|kutu|liriomyza|jamur|embun tepung|powdery|downy|pythium|busuk|kuning|keriting|bintik)\b/,
    ringkasQwen: 'Hama/Penyakit Melon GARAP: bintik putih+gulung (tungau/thrips/kutu kebul) -> sticky trap kuning+minyak mimba 3-5 mL/L sore; embun tepung -> KHCO3 / Trichoderma + sirkulasi udara; busuk akar Pythium -> jaga suhu air <28 C + aerasi + sanitasi H2O2.',
  },
  {
    id: 'varietas_dan_jadwal_hst',
    bobotPola: /\b(?:varietas|inthanon|golden aroma|fujisawa|cantaloupe|rock melon|kirani|jadwal|kalender|siklus|umur)\b/,
    ringkasQwen: 'Varietas & Jadwal HST Melon GARAP: Inthanon/Golden Aroma/Fujisawa (panen 60-70 HST, 13-15+ Brix). Fase: Semai 0-12 HSS (400-600 PPM), Vegetatif 1-21 HST (800-1000 PPM, wiwil ruas 1-8), Polinasi 22-32 HST (1000-1200 PPM, ruas 9-12), Pembesaran 33-58 HST (1400-1800 PPM, topping daun 25-28), Pematangan 59-70 HST (800-1000 PPM).',
  },
  {
    id: 'media_air_baku_sterilisasi',
    bobotPola: /\b(?:media|cocopeat|sekam|hydroton|dutch bucket|nft|dft|air baku|sumur|pdam|sterilisasi|sanitasi|greenhouse)\b/,
    ringkasQwen: 'Perkebunan & Media Melon GARAP: Air baku ideal TDS <150 PPM, DO >6 mg/L, pH 5.8-6.5. Cocopeat wajib dicuci hingga EC <0.5 mS/cm bebas tanin. Pekatan A & B dilarang dicampur pekat (cegah endapan gipsum). Antar-musim cuci instalasi dengan H2O2 3% & solarisasi greenhouse.',
  },
  {
    id: 'layu_virus_ulat_lalat',
    bobotPola: /\b(?:layu|fusarium|ralstonia|bakteri|virus|gemini|mozaik|ulat|lalat buah|kumbang|oteng)\b/,
    ringkasQwen: 'Perlindungan Kebun Melon: Layu Fusarium/Bakteri -> cabut tanaman sakit, cegah dengan Trichoderma + PGPR & suhu air <28 C. Virus Gemini (mozaik keriting kuning) -> cabut tanaman, basmi vektor Kutu Kebul & sterilisasi gunting pangkas dengan alkohol 70%. Ulat/lalat buah -> Bacillus thuringiensis & perangkap Metil Eugenol di luar greenhouse.',
  },
];

/**
 * Cari potongan pengetahuan Melon paling relevan untuk disisipkan ke Qwen (<75 token).
 * @param {string} pesan
 * @returns {string|null}
 */
function cariKonteksQwen(pesan) {
  const s = normalisasi(pesan);
  if (!s) return null;
  let terbaik = null;
  let skorMax = 0;
  for (const m of MODUL_MELON) {
    const matches = s.match(new RegExp(m.bobotPola.source, 'g'));
    if (matches && matches.length > skorMax) {
      skorMax = matches.length;
      terbaik = m.ringkasQwen;
    }
  }
  return terbaik;
}

module.exports = {
  SOP_SEMAI_MELON_LAPANGAN,
  MODUL_MELON,
  cariKonteksQwen,
};

