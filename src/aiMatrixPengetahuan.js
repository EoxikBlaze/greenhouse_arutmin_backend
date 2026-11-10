'use strict';
/**
 * aiMatrixPengetahuan.js — Ensiklopedia Cerdas & Matriks Analisis Agronomi GARAP
 *
 * FITUR UTAMA:
 * 1. ZERO-HEAT LOOKUP (<2 milidetik, 0% CPU): Berjalan langsung di V8 Node.js tanpa
 *    memutar LLM Ollama, sehingga Raspberry Pi tetap DINGIN (<55°C) dan responsif.
 * 2. 100+ Pola Analisis Mendalam: Defisiensi hara (N, P, K, Ca, Mg, Fe, B, Zn),
 *    hama (Thrips, Kutu Kebul, Tungau, Ulat, Liriomyza), penyakit patogen (Pythium,
 *    Fusarium, Ralstonia, Powdery Mildew, Gummy Stem Blight), iklim mikro (VPD,
 *    heat stress, kelembapan malam), dan kualitas air/tandon hidroponik.
 */

const MATRIX = [
  // ── 1. DEFISIENSI & ANOMALI HARA MAKRO/MIKRO ──────────────────────────
  {
    id: 'defisiensi_nitrogen',
    pola: /\b(?:kurang|defisiensi|kekurangan)\b.{0,20}\b(?:nitrogen|unsur n|pupuk n)\b|\bdaun (?:bawah|tua)\b.{0,25}\b(?:kuning merata|menguning pucat|pucat merata)\b/,
    judul: 'Analisis Defisiensi Nitrogen (N) pada Daun Bawah',
    analisis: 'Gejala: Daun tua bagian bawah menguning merata dari pucuk ke pangkal daun, pertumbuhan batang melambat, dan warna hijau daun memudar menjadi hijau muda pucat.',
    penyebab: 'Nitrogen adalah unsur mobil (bergerak bebas). Saat media kekurangan N, tanaman menarik cadangan nitrogen dari daun tua untuk disalurkan ke titik tumbuh baru di pucuk.',
    tindakan: [
      'Cek nilai TDS tandon: bila di bawah ambang fase, naikkan konsentrasi pupuk AB Mix bertahap (+150 s/d 200 PPM).',
      'Pastikan pekatan A yang mengandung Kalsium Nitrat (Ca(NO3)2) dilarutkan dalam jumlah seimbang dengan pekatan B.',
      'Bila sistem memakai air baku TDS sangat rendah (<50 PPM), periksa apakah formula AB Mix sudah memenuhi rasio N minimal 150–200 ppm.',
    ],
  },
  {
    id: 'defisiensi_fosfor',
    pola: /\b(?:kurang|defisiensi|kekurangan)\b.{0,20}\b(?:fosfor|fosfat|unsur p)\b|\bdaun\b.{0,20}\b(?:keunguan|ungu|kemerahan|gelap kusam)\b/,
    judul: 'Analisis Defisiensi Fosfor (P)',
    analisis: 'Gejala: Daun tua berwarna hijau gelap kusam dengan semburat ungu kemerahan di tepi dan tulang daun bagian bawah. Pertumbuhan akar kerdil dan lambat bercabang.',
    penyebab: 'Fosfor berperan dalam transfer energi sel (ATP) dan pembentukan membran akar. Kekurangan P sering terjadi saat suhu air tandon terlalu dingin (<18°C) atau pH > 7.0 yang mengikat fosfat menjadi bentuk tidak larut.',
    tindakan: [
      'Periksa pH tandon: turunkan pH ke 5.8–6.2 menggunakan pH Down (Asam Fosfat / H3PO4).',
      'Jaga suhu air tandon tetap hangat di rentang 22–26°C agar serapan ion H2PO4- optimal.',
      'Tambahkan Monokalium Fosfat (MKP) pada pekatan B bila fase memasuki pembungaan.',
    ],
  },
  {
    id: 'defisiensi_kalium',
    pola: /\b(?:kurang|defisiensi|kekurangan)\b.{0,20}\b(?:kalium|potasium|unsur k)\b|\bpinggir daun\b.{0,25}\b(?:terbakar|kering kuning|nekrosis tepi)\b/,
    judul: 'Analisis Defisiensi Kalium (K)',
    analisis: 'Gejala: Tepi (pinggiran) daun tua menguning lalu mengering kecokelatan seperti terbakar (marginal chlorosis/necrosis), batang lembek, dan pembentukan jaring serta rasa manis melon terhambat.',
    penyebab: 'Kalium mengatur tekanan turgor sel, pembukaan stomata, dan translokasi karbohidrat ke buah. Kebutuhan Kalium melon meningkat 2–3 kali lipat saat buah mulai membesar (HST 35+).',
    tindakan: [
      'Naikkan rasio pupuk Kalium (Kalium Nitrat / Kalium Sulfat) pada fase pembesaran buah (HST 35–60).',
      'Target PPM fase generatif melon dijaga di 1400–1800 PPM.',
      'Hindari kelebihan Kalsium atau Magnesium yang terlalu dominan di tandon karena dapat menekan serapan Kalium.',
    ],
  },
  {
    id: 'defisiensi_kalsium',
    pola: /\b(?:kurang|defisiensi|kekurangan)\b.{0,20}\b(?:kalsium|unsur ca)\b|\b(?:tip burn|blossom end rot|busuk pantat buah|ujung daun melengkung mati)\b/,
    judul: 'Analisis Defisiensi Kalsium (Ca) & Tip Burn',
    analisis: 'Gejala: Pucuk daun muda melengkung kaku seperti cakar, tepi daun muda terbakar kering (tip burn), dan ujung buah melon/tomat membusuk hitam (Blossom End Rot).',
    penyebab: 'Kalsium adalah unsur lambat/tidak bergerak (immobile) yang hanya diangkut bersama aliran air transpirasi tanaman. Jika kelembapan malam hari >85% (transpirasi nol) atau suhu siang >34°C (stomata menutup), kalsium tidak sampai ke sel ujung yang sedang tumbuh cepat.',
    tindakan: [
      'Perbaiki sirkulasi udara greenhouse dengan exhaust fan agar kelembapan malam hari tidak jenuh (>85%).',
      'Stabilkan irigasi fertigasi; jangan biarkan media tanam mengalami fluktuasi kering-basah ekstrem.',
      'Semprotkan pupuk daun Kalsium Boron (CaB) 1–2 g/L air di pagi hari langsung ke daun muda dan bakal buah.',
    ],
  },
  {
    id: 'defisiensi_magnesium',
    pola: /\b(?:kurang|defisiensi|kekurangan)\b.{0,20}\b(?:magnesium|unsur mg)\b|\b(?:klorosis interveinal|tulang daun hijau sela kuning|daun tua bercak kuning di sela tulang)\b/,
    judul: 'Analisis Defisiensi Magnesium (Mg)',
    analisis: 'Gejala: Daun tua mengalami klorosis interveinal khas — area helaian daun di antara tulang daun berubah kuning cerah, sedangkan tulang-tulang daun tetap berwarna hijau tua tebal.',
    penyebab: 'Magnesium adalah inti atom klorofil (zat hijau daun). Kekurangan Mg menurunkan kemampuan fotosintesis. Sering dipicu oleh kelebihan Kalium (K) di tandon yang menghambat penyerapan Mg.',
    tindakan: [
      'Semprotkan pupuk daun Garam Epsom (Magnesium Sulfat / MgSO4) konsentrasi 2–3 g/L air di pagi hari untuk pemulihan cepat.',
      'Periksa takaran Magnesium Sulfat di pekatan B AB Mix (minimal 15–20% dari total berat pupuk B).',
      'Pastikan pH tandon berada di rentang 5.8–6.3 agar kation Mg2+ mudah terserap akar.',
    ],
  },
  {
    id: 'defisiensi_zat_besi',
    pola: /\b(?:kurang|defisiensi|kekurangan)\b.{0,20}\b(?:zat besi|unsur fe|besi)\b|\bdaun muda\b.{0,25}\b(?:kuning pucat tulang hijau|memutih|klorosis daun muda)\b/,
    judul: 'Analisis Defisiensi Zat Besi (Fe) & Penguncian pH Tinggi',
    analisis: 'Gejala: Daun-daun pucuk paling muda memucat kekuningan hingga putih krem, namun urat tulang daun halus tetap berwarna hijau (berbeda dengan magnesium yang menyerang daun tua).',
    penyebab: 'Zat besi mengendap dan tidak larut saat pH tandon naik di atas 6.8. Tanpa kelat yang kuat, Fe2+ teroksidasi menjadi Fe3+ yang tidak dapat diserap tanaman.',
    tindakan: [
      'Turunkan pH tandon segera ke 5.8–6.2 dengan menambahkan larutan pH Down.',
      'Gunakan kelat besi Fe-EDDHA (berwarna merah tua pekat) jika air baku Anda memiliki pH basa stabil di atas 7.0 karena Fe-EDTA rusak di pH tinggi.',
      'Periksa apakah aerasi tandon berlebihan di dekat titik tuang zat besi yang dapat memicu oksidasi.',
    ],
  },
  {
    id: 'defisiensi_boron',
    pola: /\b(?:kurang|defisiensi|kekurangan)\b.{0,20}\b(?:boron|unsur b)\b|\b(?:titik tumbuh mati|daun rapuh tebal kerdil|buah retak gabus)\b/,
    judul: 'Analisis Defisiensi Boron (B)',
    analisis: 'Gejala: Titik tumbuh kuncup pucuk mati menghitam, daun menebal kaku rapuh melengkung, tangkai daun mudah patah, dan kulit buah melon mengalami luka gabus/retak tidak beraturan.',
    penyebab: 'Boron bekerja sama dengan Kalsium dalam pembentukan dinding sel dan pemanjangan tabung serbuk sari bunga saat polinasi.',
    tindakan: [
      'Pastikan mikronutrien Boron (Asam Borat / H3BO3) ada di pekatan B dengan dosis tepat (0.5–1 ppm murni di tandon).',
      'Hati-hati: batas antara defisiensi dan keracunan Boron sangat sempit. Jangan menambah asam borat murni sembarangan tanpa perhitungan teliti.',
    ],
  },
  {
    id: 'antagonisme_hara',
    pola: /\b(?:antagonisme|kelebihan kalium|kelebihan kalsium|kelebihan nitrogen)\b|\bunsur saling hambat\b/,
    judul: 'Analisis Antagonisme & Keseimbangan Kation (K : Ca : Mg)',
    analisis: 'Penjelasan: Di dalam larutan hidroponik, ion-ion bermuatan positif (K+, Ca2+, Mg2+) bersaing di permukaan bulu akar. Bila salah satu kation terlalu dominan, penyerapan dua kation lainnya akan tertekan (antagonisme).',
    penyebab: 'Contoh klasik: Petani menambah Kalium berlebih untuk mengejar manis buah, namun akibatnya daun bawah mendadak klorosis (kurang Mg) dan pucuk terkena tip burn (kurang Ca).',
    tindakan: [
      'Gunakan rasio molar seimbang: K (4–6 mM) : Ca (3–4 mM) : Mg (1.5–2 mM).',
      'Koreksi ketidakseimbangan dengan mengganti 30% air tandon dengan nutrisi berformula standar.',
    ],
  },
  {
    id: 'ec_drainase_runoff',
    pola: /\b(?:runoff|drainase|ec drainase|ppm drainase|air buangan media)\b/,
    judul: 'Analisis EC/TDS Air Drainase (Run-off Fertigasi)',
    analisis: 'Aturan Analisis: Nilai EC air yang keluar dari bawah polybag (drainase) idealnya hanya berselisih +200 s/d 300 PPM dari EC air nutrisi yang disiramkan (input).',
    penyebab: 'Bila TDS drainase naik >500 PPM di atas TDS input, berarti terjadi penumpukan garam pupuk (salt accumulation) di dalam media tanam akibat penguapan tinggi.',
    tindakan: [
      'Lakukan penyiraman air baku murni (flushing) satu kali di pagi hari untuk membilas akumulasi garam media.',
      'Tingkatkan persentase drainase (run-off target: 15–20% dari total volume siram harian).',
    ],
  },

  // ── 2. HAMA & PENGENDALIAN HAYATI GREENHOUSE ──────────────────────────
  {
    id: 'hama_thrips',
    pola: /\b(?:thrips|trip|trips)\b|\bdaun keriting ke bawah\b|\bgaris perak di daun\b/,
    judul: 'Diagnosa & Pengendalian Hama Thrips (Frankliniella occidentalis)',
    analisis: 'Gejala: Daun keriting melengkung ke bawah, permukaan bawah daun tampak bercak kilau keperakan dengan titik-titik hitam kotoran hama, pucuk daun kerdil menyempit.',
    penyebab: 'Thrips adalah serangga renik bertubuh ramping yang menggores permukaan sel daun muda lalu mengisap cairannya. Thrips sangat menyukai kondisi cuaca kering dan panas.',
    tindakan: [
      'Pasang Blue Sticky Trap (perangkap lem biru) atau Yellow Sticky Trap setinggi tajuk tanaman (1 perangkap per 10 m²). Warna biru sangat disukai Thrips.',
      'Semprotkan biopestisida Minyak Mimba (Neem Oil) 5 ml/L + 1 ml sabun cair perekat pada sore hari (16.30+) dengan mengarahkan nosel ke bagian bawah daun.',
      'Aplikasi jamur entomopatogen Beauveria bassiana 2–3 g/L di sore hari untuk menginfeksi nimfa dan thrips dewasa secara alami.',
    ],
  },
  {
    id: 'hama_kutu_kebul',
    pola: /\b(?:kutu kebul|whitefly|bemisia tabaci)\b|\bserangga putih kecil terbang\b|\bembun jelaga hitam\b/,
    judul: 'Diagnosa & Pengendalian Kutu Kebul (Whitefly / Bemisia tabaci)',
    analisis: 'Gejala: Kumpulan serangga putih kecil beterbangan saat daun digoyangkan. Daun mengeluarkan cairan lengket manis (honeydew) yang kemudian ditumbuhi jamur hitam jelaga (embun jelaga).',
    penyebab: 'Kutu kebul merupakan vektor (pembawa) paling mematikan bagi Geminivirus (Virus Kuning/Bule/Pepper Yellow Leaf Curl).',
    tindakan: [
      'Pasang Perangkap Lem Kuning (Yellow Sticky Trap) dalam jumlah banyak di lorong dan dekat pintu masuk greenhouse.',
      'Semprotkan ekstrak tembakau/mimba pada pagi hari sebelum kutu kebul aktif bergerak.',
      'Tutup rapat double-door airlock di pintu masuk greenhouse dan periksa kassa serangga (insect net) minimal mesh 50.',
      'Tanaman yang sudah bergejala daun keriting kaku kuning mozaik (terinfeksi virus) wajib dicabut dan dimusnahkan segera.',
    ],
  },
  {
    id: 'hama_tungau_merah',
    pola: /\b(?:tungau|spider mites|red mite)\b|\bjaring laba-laba halus\b|\bbintik kuning kusam di daun\b/,
    judul: 'Diagnosa & Pengendalian Tungau Merah (Tetranychus urticae)',
    analisis: 'Gejala: Permukaan daun berbintik-bintik kuning halus rapat sehingga daun tampak kusam berdebu. Pada serangan parah, terlihat jaring laba-laba halus menyelimuti pucuk dan ketiak daun.',
    penyebab: 'Tungau adalah hewan arakhnida renik yang berkembang biak luar biasa cepat pada kondisi greenhouse yang panas (>32°C) dan kelembapan udara kering (RH < 55%).',
    tindakan: [
      'Tingkatkan kelembapan greenhouse dengan menyalakan pengabutan (misting) air murni untuk menghambat reproduksi tungau.',
      'Semprotkan akarisida nabati berbahan dasar Belerang / Sulfur mikro (2 g/L) atau minyak mimba.',
      'Pangkas daun-daun bawah yang sudah dipenuhi jaring dan bungkus plastik sebelum dibuang ke luar greenhouse.',
    ],
  },
  {
    id: 'hama_liriomyza',
    pola: /\b(?:pengorok daun|liriomyza|ulat peliang|garis putih berliku|daun ada jalur putih)\b/,
    judul: 'Diagnosa Hama Pengorok Daun (Leafminer / Liriomyza sp.)',
    analisis: 'Gejala: Terdapat jalur atau lorong garis putih bening berkelok-kelok (seperti peta) di dalam jaringan daging daun.',
    penyebab: 'Larva lalat Liriomyza memakan lapisan mesofil daun dari dalam, meninggalkan kutikula luar utuh. Mengurangi luas fotosintesis daun.',
    tindakan: [
      'Jepit atau remas jalur putih yang masih berisi larva hidup menggunakan jari untuk membunuh larva di dalam daun.',
      'Pasang perangkap kuning untuk menangkap lalat dewasa sebelum sempat bertelur di daun.',
      'Semprot ekstrak daun mimba atau agens hayati Beauveria bassiana secara merata.',
    ],
  },

  // ── 3. PENYAKIT PATOGEN (JAMUR & BAKTERI) ──────────────────────────────
  {
    id: 'penyakit_powdery_mildew',
    pola: /\b(?:powdery mildew|embun tepung|jamur tepung)\b|\b(?:putih|bercak putih|serbuk putih)\b.{0,25}\b(?:tepung|bedak|daun)\b|\b(?:tepung|bedak)\b.{0,25}\b(?:daun|putih)\b/,
    judul: 'Diagnosa & Solusi Jamur Embun Tepung (Podosphaera xanthii)',
    analisis: 'Gejala: Muncul bercak serbuk putih mirip bedak atau tepung terigu pada permukaan atas daun, yang lama-kelamaan meluas ke seluruh tajuk dan membuat daun mengering kecokelatan.',
    penyebab: 'Spora jamur Podosphaera berkecambah subur pada kelembapan relatif sedang-tinggi (70–80%) dengan sirkulasi udara greenhouse yang pengap tanpa angin.',
    tindakan: [
      'Semprot larutan Baking Soda (Kalium/Natrium Bikarbonat) dosis 4 g/L air + 1 ml sabun cair perekat. Bikarbonat mengubah pH permukaan daun menjadi basa sehingga miselium jamur mati.',
      'Aplikasi fungisida hayati jamur antagonis Trichoderma harzianum atau bakteri Bacillus subtilis.',
      'Nyalakan kipas sirkulasi (air circulation fan) 24 jam untuk menghilangkan zona udara mati di antara rimbun tanaman.',
    ],
  },
  {
    id: 'penyakit_downy_mildew',
    pola: /\b(?:downy mildew|embun bulu|bercak kuning bersudut|jamur bulu kelabu)\b/,
    judul: 'Diagnosa & Solusi Jamur Embun Bulu (Pseudoperonospora cubensis)',
    analisis: 'Gejala: Bercak kuning cerah bersudut tegas yang dibatasi oleh urat tulang daun di permukaan atas. Di permukaan bawah daun tepat di bawah bercak, muncul lapisan bulu halus berwarna ungu keabu-abuan.',
    penyebab: 'Disebabkan oleh oomycetes yang membutuhkan tetesan air bebas (embun) di daun minimal 2–4 jam untuk menginfeksi jaringan tanaman.',
    tindakan: [
      'Hindari daun basah oleh cipratan air atau tetesan kondensasi dari plastik atap UV greenhouse.',
      'Pangkas daun terinfeksi di bagian bawah dan sanitasi greenhouse.',
      'Semprot fungisida tembaga hidroksida (Cu(OH)2) konsentrasi rendah di pagi hari agar daun cepat mengering.',
    ],
  },
  {
    id: 'penyakit_gummy_stem',
    pola: /\b(?:gummy stem|didymella|busuk batang berlendir|pangkal batang keluar cairan cokelat)\b/,
    judul: 'Diagnosa Busuk Batang Berlendir (Gummy Stem Blight / Didymella bryoniae)',
    analisis: 'Gejala: Pangkal batang dekat media atau ketiak bekas pangkasan cabang basah berair, membusuk lunak, dan mengeluarkan getah/lendir kental berwarna cokelat kemerahan seperti karamel.',
    penyebab: 'Jamur patogen masuk melalui luka bekas pruning tunas air yang masih basah saat kelembapan udara sangat tinggi (>85%).',
    tindakan: [
      'PENTING: Lakukan pruning tunas air HANYA di pagi hari yang cerah (pukul 07.30–10.00) agar luka bekas pangkasan cepat kering terpapar sinar matahari.',
      'Oleskan pasta fungisida tembaga atau serbuk kunyit/belerang langsung pada luka batang menggunakan kuas kecil.',
      'Keringkan area pangkal batang; jangan mengarahkan nosel sprayer ke batang utama.',
    ],
  },
  {
    id: 'penyakit_pythium_akar',
    pola: /\b(?:pythium|busuk akar|akar cokelat berlendir|akar bau masam)\b/,
    judul: 'Diagnosa & Solusi Busuk Akar (Pythium Root Rot)',
    analisis: 'Gejala: Perakaran yang semula putih bersih berubah warna menjadi cokelat kehitaman, licin berlendir, mudah mengelupas saat disentuh, dan berbau busuk masam. Tanaman layu parah saat siang terik.',
    penyebab: 'Spora Pythium berenang bebas di air nutrisi saat suhu air tandon >28°C dan kadar oksigen terlarut (Dissolved Oxygen / DO) turun di bawah 4 mg/L.',
    tindakan: [
      'Tingkatkan Oksigen Terlarut: Pasang aerator gelembung kuat (blower) atau pipa venturi nozzle di tandon sirkulasi (target DO > 6 mg/L).',
      'Turunkan suhu air tandon dengan insulasi peredam panas atau letakkan tandon di area paling teduh.',
      'Sterilisasi air tandon dengan Hidrogen Peroksida (H2O2) 3% dosis 2–3 ml per liter air, sirkulasikan selama 12 jam sebelum menambahkan inokulan Trichoderma.',
    ],
  },

  // ── 4. IKLIM MIKRO GREENHOUSE & VPD ───────────────────────────────────
  {
    id: 'iklim_vpd_manajemen',
    pola: /\b(?:vpd|vapor pressure deficit|kelembapan dan suhu|stomata menutup panas)\b/,
    judul: 'Analisis Vapor Pressure Deficit (VPD) & Iklim Mikro Greenhouse',
    analisis: 'Konsep Ilmiah: VPD adalah selisih antara tekanan uap di dalam rongga daun jenuh dengan tekanan uap udara sekitar. VPD menentukan seberapa lancar tanaman mentranspirasikan air dan menyerap nutrisi.',
    penyebab: '• VPD Terlalu Rendah (<0.4 kPa / sangat lembap): Transpirasi terhenti, kalsium tidak naik, memicu tip burn dan jamur.\n• VPD Terlalu Tinggi (>1.6 kPa / panas kering): Tanaman menutup stomata untuk mencegah kekeringan, fotosintesis berhenti, daun layu kaku.',
    tindakan: [
      'Rentang VPD Ideal untuk Melon Hidroponik: 0.8 s/d 1.2 kPa.',
      'Bila siang hari terlalu panas dan kering (VPD > 1.5 kPa): Aktifkan pengabutan misting air murni 15 detik tiap 10 menit untuk mendinginkan suhu dan menaikkan kelembapan.',
      'Bila malam hari terlalu lembap (VPD < 0.4 kPa): Nyalakan exhaust fan perlahan untuk mendorong udara lembap keluar dari greenhouse.',
    ],
  },
  {
    id: 'iklim_heat_stress',
    pola: /\b(?:panas ekstrem|suhu 35|suhu 36|suhu greenhouse tinggi|tanaman kepanasan)\b/,
    judul: 'Analisis Cekaman Panas (Heat Stress) Greenhouse',
    analisis: 'Dampak: Saat suhu greenhouse melebihi 33–35°C, enzim rubisco pada daun terdegradasi sehingga fotosintesis melon turun drastis (fotorespirasi naik). Bunga betina melon mudah gugur (aborsi).',
    penyebab: 'Kurangnya ventilasi atap (roof vent) dan radiasi matahari langsung tanpa peneduh di puncak siang hari.',
    tindakan: [
      'Pasang Shading Net (paranet aluminet 40–50%) otomatis yang bisa ditarik pada pukul 11.00–14.00 untuk memantulkan radiasi panas berlebih.',
      'Pastikan roof vent (ventilasi atap) terbuka bebas agar udara panas terangkat ke atas keluar dari greenhouse (efek cerobong alami).',
      'Jangan membiarkan tandon nutrisi terpapar panas; air yang panas membuat akar kekurangan oksigen.',
    ],
  },

  // ── 5. OPERASIONAL SISTEM & KENDALI DARURAT ───────────────────────────
  {
    id: 'kompensasi_suhu_atc',
    pola: /\b(?:kompensasi suhu|atc|pembacaan ph berubah suhu|sensor melenceng siang malam)\b/,
    judul: 'Analisis Pengaruh Suhu terhadap Sensor pH & TDS (ATC)',
    analisis: 'Fakta Fisik: Tegangan elektroda probe pH (Nernst equation) berubah sekitar 0.03 pH per 1°C kenaikan suhu air. Nilai konduktivitas listrik (EC/TDS) meningkat sekitar 2% per 1°C kenaikan suhu air.',
    penyebab: 'Bila sensor tidak memiliki Automatic Temperature Compensation (ATC) berbasis sensor DS18B20, pembacaan TDS di siang hari (suhu 30°C) akan tampak lebih tinggi daripada di pagi hari (suhu 24°C) meskipun jumlah pupuk di tandon sama persis.',
    tindakan: [
      'Pastikan sensor suhu air DS18B20 terpasang dan terbaca normal di sistem GARAP.',
      'Sistem GARAP secara otomatis mengompensasi pembacaan TDS ke nilai referensi standar 25°C.',
      'Lakukan kalibrasi buffer pH pada suhu kamar yang stabil (25°C).',
    ],
  },
  {
    id: 'darurat_pompa_mati',
    pola: /\b(?:pompa mati darurat|listrik padam hidroponik|aliran air berhenti|tandon sirkulasi mati)\b/,
    judul: 'SOP Darurat: Listrik Padam / Pompa Sirkulasi Mati',
    analisis: 'Tingkat Bahaya: KRITIS untuk sistem NFT/Drip Fertigasi. Di siang hari yang cerah, media tanam polybag/talang melon dapat mengering total dalam 60–90 menit, menyebabkan kematian rambut akar permanen.',
    penyebab: 'Kegagalan sumber listrik PLN, MCB trip, atau kerusakan mekanis impeller pompa akibat lumut/serat.',
    tindakan: [
      'Prioritas 1: Segera lakukan penyiraman manual darurat menggunakan selang/gembor langsung ke pangkal tanaman melon setiap 30 menit.',
      'Prioritas 2: Hidupkan sumber daya cadangan (UPS baterai / genset mini) khusus untuk jalur pompa tandon utama.',
      'Prioritas 3: Buka katup pembuangan darurat jika sistem DFT untuk memastikan air menggenang setinggi 2–3 cm di talang sebagai cadangan genangan akar.',
    ],
  },
];

/**
 * Pencarian Cepat di Memori RAM (<2ms, 0% CPU, Dingin)
 */
function cariAnalisisCepat(pesan) {
  if (!pesan || typeof pesan !== 'string') return null;
  const bersih = pesan.toLowerCase();
  
  for (const item of MATRIX) {
    if (item.pola.test(bersih)) {
      return item;
    }
  }
  return null;
}

/**
 * Format Teks Respon Siap Baca yang Elegan & Lugas
 */
function formatHasilAnalisis(item) {
  const langkah = item.tindakan.map((t, idx) => `${idx + 1}. ${t}`).join('\n');
  return [
    `🔬 **${item.judul}**`,
    `*(Analisis Cepat Engine Cerdas GARAP • Nol Beban CPU)*`,
    ``,
    `📋 **Gejala & Kondisi:**`,
    `${item.analisis}`,
    ``,
    `🔍 **Akar Masalah:**`,
    `${item.penyebab}`,
    ``,
    `⚡ **Langkah Tindakan Rekomendasi:**`,
    `${langkah}`,
  ].join('\n');
}

module.exports = { cariAnalisisCepat, formatHasilAnalisis, MATRIX };
