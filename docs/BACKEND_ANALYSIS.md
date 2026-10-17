# Analisis Backend — GARAP

Tanggal: 2026-10-14 · Status: Laravel (existing) dianalisis → di-port ke **Node.js**

## 1) Ringkasan arsitektur (sebelum port)

| Aspek | Kondisi |
|---|---|
| Framework | Laravel 13.31 · PHP 8.5 · session auth (cookie) |
| Database | PostgreSQL 17 (`vertonik_smartfarm`) — sebelumnya SQLite |
| Frontend | React SPA (Vite) di belakang proxy same-origin; backend API-only (JSON, tanpa HTML) |
| Perangkat | ESP32 → endpoint `/api/*` (X-API-KEY) + `/monitoring/saveSensor` (publik) |
| Notifikasi | WhatsApp via Fonnte (API key + nomor di tabel `wa_settings`) |

## 2) Inventaris API (104 route → dikontrak ulang 1:1 di Node)

### Publik / perangkat
| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/latest-sensor` | polling live (sensor + status alat + water_control + anomali) |
| GET | `/api/get-thresholds` | ambang untuk ESP32 (**X-API-KEY**) |
| POST | `/api/save-sensor` | terima data sensor ESP32 (**X-API-KEY**) |
| POST | `/api/notif-hardware` | alert dari ESP32 → alert_logs + WA (**X-API-KEY**) |
| POST | `/monitoring/saveSensor` | duplikat publik (kompatibilitas CI4) |
| POST | `/monitoring/saveAlert` | alert publik (tanpa kirim WA) |
| GET | `/monitoring/getReport6Jam` | rata-rata 6 jam + alert 6 jam (JSON) |

### Auth
`GET /login` (info) · `POST /login` · `GET /logout` · `GET /` (info)

### Halaman/API terproteksi (role admin+demo kecuali disebut)
| Group | Paths | Role |
|---|---|---|
| Dashboard | `GET /dashboard` | semua |
| Monitoring | `GET /monitoring`, `/monitoring/chart-data`, `/monitoring/tarik`, `/monitoring/tarik/csv` | semua |
| Tanam Saya | `GET/POST /tanam`, `/tanam/mulai`, `/tanam/{tipe}/{id}/selesai`, `/tanam/{id}/hapus` | semua |
| Water Control | `GET /watercontrol`, `/watercontrol/status`, `POST /watercontrol/fill|stop|setMode` | admin+demo(dilarang aksi) |
| Data Tahap | resource `semai` (+`/semai/batch/{id}`, `/semai/selesai`), `peremajaan`, `pendewasaan`, `panen` | admin+demo |
| Master | resource `meja`, `tanaman`, `ambang` · `siklus` (+`siklus/csv`) | admin+demo |
| Laporan | `GET /laporan`, `/laporan/csv` | admin+demo |
| Notif WA | `GET/POST /notifikasi-wa`, `POST /notifikasi-wa/uji` | admin+demo (demo dilarang uji) |
| Profil | `GET /profil`, `POST /profil/update`, `GET/POST /profil/password` | semua |
| User | resource `user` | admin+demo (demo dilarang kelola) |

## 3) Model data (12 tabel domain)
`users` (level admin/user/petani + is_demo + expires_at) · `mejas` · `tanamen` · `sikluses` ·
`semais` → `peremajaans` → `pendewasaans` → `panens` (rantai FK 4 tahap) · `monitorings` (log sensor) ·
`alert_logs` · `sensor_thresholds` (unique per sensor) · `water_controls` (1 baris: command/mode/valve_state) ·
`wa_settings` (1 baris: api_key TER-ENKRIPSI + target) · 7 tabel domain punya `expires_at` (data demo).

## 4) Otorisasi (kontrak yang dipertahankan)
1. **Petani** → hanya: `tanam*`, `dashboard`, `monitoring*`, `profil*`, `logout` (sumber: PetaniGuard).
2. **Demo** = admin read-only: BOLEH `tambah` saja (meja/tanaman/siklus/semai/peremajaan/pendewasaan/panen/tanam.mulai/tanam.selesai); dilarang edit/hapus, kelola user, ganti profil, kontrol kran, kirim uji WA. Data demo = `expires_at` +1 jam, dibersihkan otomatis (`demo:purge`).
3. **ESP32** → `X-API-KEY` harus cocok `ESP32_API_KEY`.
4. Field sensitif: `users.password` & `remember_token` tersembunyi dari semua JSON.

## 5) Analisis keamanan

| Aspek | Status | Catatan |
|---|---|---|
| Password | ✅ bcrypt | hash Laravel `$2y$` — kompatibel dengan `bcryptjs` |
| Enkripsi data at-rest | ✅ | `wa_settings.api_key` = AES-256-CBC + HMAC (kunci `APP_KEY`) |
| Session/cookie | ✅ | Laravel session ter-enskripsi |
| Transport | ⚠️ | masih HTTP lokal; **wajib HTTPS** di produksi → Node backend: dukung HTTPS (self-signed untuk lokal) |
| API-only | ✅ | tidak ada HTML; error JSON generik **tanpa stack trace** |
| Rate limit | ⚠️ | belum ada (target penambahan: limit login) |
| CSRF | — | tidak relevan untuk API JWT |

### Temuan saat debugging Laravel
1. `enum()->change()` tidak valid di PostgreSQL (migration harus `string()` + CHECK manual).
2. `wa_settings.api_key` `varchar(100)` terlalu pendek untuk payload enkripsi (~228 char) → `text`.
3. `Router::toResponse()` **static** di Laravel 13 — binding router harus paling awal (`bootstrap/app.php`), jika lewat `AppServiceProvider` semua route 404.
4. Old-input sempat membocorkan `password` ke response JSON — sudah disaring.

## 6) Port ke Node.js (keputusan teknis)

| Aspek | Pilihan |
|---|---|
| Runtime | Node.js 26 · **Express 4** |
| Database | **PostgreSQL yang sama** (`vertonik_smartfarm`) via `pg` — skema & data TIDAK berubah |
| Auth | **JWT (HS256)** — stateless, cocok untuk SPA & mobile; header `Authorization: Bearer` |
| Password | `bcryptjs` (kompatibel hash Laravel) |
| Enkripsi | `crypto.js` — enkripsi kompatibel Laravel AES-256-CBC + HMAC (baca/tulis `wa_settings.api_key`); HTTPS opsional (self-signed) |
| Output | **JSON-only** — tidak ada HTML, tidak ada `console.log` data sensitif, error `{"message"}` tanpa stack |
| Port | **8000** (menggantikan Laravel; proxy React tidak berubah) |
| Bind | `127.0.0.1` saja — backend tidak terjangkau dari luar |

### Pemetaan route
Semua path di §2 diimplementasikan **1:1** (nama route/tidak diganti). Route `*/create`, `*/edit`
(form Blade) cukup mengembalikan JSON info — SPA tidak memakainya.

### Perilaku yang dipertahankan
- `watercontrol/setMode` MANUAL → otomatis `FORCE_STOP`.
- `api/save-sensor` → simpan baris sensor, angkat `command` pending lalu reset ke `AUTO`,
  deteksi online ≤120 detik, anomali vs ambang.
- Demo: `expires_at` = now+1 jam pada data yang dibuat; purge otomatis 1×/menit
  (urutan anak → induk: panens → pendewasaans → peremajaans → semais → sikluses → tanamen → mejas).
- CSV: `/laporan/csv`, `/siklus/csv`, `/monitoring/tarik/csv` (UTF-8 BOM).
