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
| admin | `@adminbersabda123` | admin |
| petani | `petani123` | petani |
| demo | `demo123` | demo |
