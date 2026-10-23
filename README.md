# Backend API — GARAP (Node.js)

Backend **JSON-only** yang menggantikan Laravel. Database & route 1:1 dengan
kontrak lama (lihat `docs/BACKEND_ANALYSIS.md`).

## Jalankan

```bash
cd ~/Project/Vertoniksmartfarm/backend-nodejs
cp .env.example .env   # isi DATABASE_URL, JWT_SECRET, APP_KEY, ESP32_API_KEY
npm install
npm start              # http://127.0.0.1:8000 (hanya localhost)
npm run start:https    # + HTTPS (self-signed)
```

## Restore database — SATU perintah (jangan manual)

Restore manual (`psql -f dump.sql`) sering lupa lanjut ke perbaikan sequence →
semua INSERT balas **500**. Pakai script, semua langkah jalan otomatis:

```bash
scripts/restore.sh database/vertonik.sql
#  → [1] psql -f dump  [2] database/migrations/*.sql  [3] fix-sequences (terakhir)  [4] verifikasi
DATABASE_URL=postgres://.../db_lain scripts/restore.sh dump.sql   # ke DB lain
```

Kalau terlanjur restore manual, jalankan: `psql "$DATABASE_URL" -f scripts/fix-sequences.sql`

## Enkripsi

| Lapisan | Cara |
|---|---|
| Password | bcrypt (kompatibel hash Laravel `$2y$`) |
| Token auth | JWT HS256 (`Authorization: Bearer`) |
| Data sensitif (`wa_settings.api_key`) | AES-256-CBC + HMAC kompatibel Laravel (kunci `APP_KEY`) |
| Transport | bind localhost saja; HTTPS opsional (`HTTPS=1`) |

## Aturan output

- Tidak pernah ada HTML — semua response `application/json` (CSV kecuali).
- Error generik `{"message"}` — **tanpa stack trace / path server / SQL**.
- `password`, `password_confirmation`, `_token` tidak pernah dikirim balik.
- `api_key` dikirim hanya versi tersamar (`FONNTE***`).

## Role

- **admin** — semua
- **petani** — hanya `dashboard`, `monitoring*`, `tanam*`, `profil*`, `logout`
- **demo** — boleh tambah data sementara (`expires_at` +1 jam, auto-purge);
  dilarang edit/hapus, kelola user, ganti profil, kontrol kran, kirim uji WA
- **ESP32** — header `X-API-KEY` untuk `/api/get-thresholds`, `/api/save-sensor`,
  `/api/notif-hardware`

## Akun seed

| username | password | level |
|---|---|---|
| admin | `<ADMIN_PASSWORD>` | admin |
| petani | `<PETANI_PASSWORD>` | petani |
| demo | `<DEMO_PASSWORD>` | demo |


> **Kredensial**: nilai password hanya ada di `backend-nodejs/.env` (kunci `ADMIN_PASSWORD`, `PETANI_PASSWORD`, `DEMO_PASSWORD`). Jangan pernah ditulis di dokumen atau repo.

## Database

```bash
npm run migrate:status   # status migrasi
npm run migrate          # jalankan migrasi yang belum
npm run db:seed-fake     # data palsu untuk debugging (hapus: psql "$DATABASE_URL" -f database/hapus_fake.sql)
```

Peta tabel, konvensi, dan cara menambah migrasi: `../docs/DATABASE.md`.

## Asisten AI — pengaman & diagnosa

`POST /api/ai/chat` (admin & petani). Alurnya:

1. **Pengaman masukan** (`src/aiGuard.js`) — normalisasi (Unicode/homoglif/leetspeak/karakter tak terlihat), deteksi injeksi ID+EN
   (override, bocor prompt, pembajakan peran, delimiter palsu, rahasia, kode/SQL, eksfiltrasi, muatan base64/hex/rot13, teks acak),
   gerbang topik, dan jeda otomatis (4 pelanggaran / 10 menit → 429 selama 5 menit). Pesan yang ditolak **tidak pernah menyentuh LLM**.
2. **Jalur deterministik** (`src/aiDiagnosa.js`) — "diagnosa menyeluruh", tabel sensor/alert/penampung/tahap dijawab langsung dari DB
   sebagai tabel terstruktur `{judul, kolom, baris}`; tanpa LLM.
3. **Jalur LLM** — pesan pengguna dibungkus `<pesan_pengguna>`, riwayat & data DB disaring ulang, system prompt memuat canary rahasia;
   keluaran disaring (canary/kutipan prompt/JWT/connection string/gambar/tautan dibuang) dan tabel Markdown diurai jadi tabel terstruktur.

Respons: `{ jawaban, tabel[], sumber: 'ollama'|'heuristik'|'diagnosa'|'data'|'tolak', status?, model, fallback_karena }`.
Tes: `node --test test/integration/ai-pengaman.test.js` (670+ variasi serangan acak dengan seed tetap).

## Endpoint publik landing page
`GET /api/publik/ringkasan` — tanpa login, hanya agregat aman (jumlah meja/lubang, rata-rata sensor 6 jam, tren 24 jam, total panen, status IoT). Di-cache 15 dtk, kena rate limit GET. Dipakai bagian "Data langsung" di landing page web.

## Catatan setup database baru
`npm run migrate` hanya menambah migrasi di atas skema dasar. Pada database kosong, muat dulu `database/vertonik.sql` (berisi tabel `audit_logs` dan lainnya), baru `npm run migrate` lalu `npm run db:seed-fake`. Memuat `schema.sql` saja membuat halaman Riwayat Audit error 500.
