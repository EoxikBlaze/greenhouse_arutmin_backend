# Susunan Database — Vertonik Smart Farm

Tanggal: 2026-10-14

## 1) Koneksi (lokal)

| Item | Nilai |
|---|---|
| Driver | **PostgreSQL 17.11** (Homebrew) |
| Host | `127.0.0.1:5432` |
| Database | `vertonik_smartfarm` |
| User | `vertonik` / password `vertonik123` |
| File `.env` | `~/Documents/Vertonik-Smart-Farm/.env` → `DB_CONNECTION=pgsql` |

> Sebelumnya SQLite (`database/database.sqlite`). Sudah diganti ke PostgreSQL.
> Migrasi `2026_10_06_000001_tambah_level_petani_users.php` disesuaikan agar kompatibel PostgreSQL
> (`enum()->change()` menghasilkan SQL invalid di pgsql → diganti `string()` + check constraint manual).

## 2) Diagram relasi (alur siklus tanam)

```
mejas ─────────────┐
  1               │
  │               ▼
  │            tanamen ──────┐
  │               1          │
  │               ▼          ▼
  │            sikluses    semais
  │                          1
  │                          ▼
  └────────────▶ peremajaans ─▶ pendewasaans ─▶ panens

users ── (login, level: admin/user/petani, is_demo)
monitorings ── (log sensor ESP32)
alert_logs ── (log alert)
sensor_thresholds ── (ambang min/max per sensor → feed ESP32)
water_controls ── (state katup + mode AUTO/MANUAL)
wa_settings ── (setelan notifikasi WhatsApp)
```

## 3) Tabel aplikasi

### `users` — akun login
| Kolom | Tipe | Keterangan |
|---|---|---|
| id | bigint PK | auto-increment |
| username | varchar(50) unique | login name |
| email | varchar unique | |
| password | varchar | hash bcrypt |
| level | varchar(20) CHECK | `admin` / `user` / `petani` (default `user`) |
| is_demo | boolean | akun demo (default false) |
| expires_at | timestamp nullable | masa berlaku data demo |
| created_at / updated_at | timestamp | |

### `sessions` — sesi login (SESSION_DRIVER=database)
| Kolom | Tipe | Keterangan |
|---|---|---|
| id | varchar PK | session id |
| user_id | FK → users.id nullable | |
| ip_address | varchar nullable | |
| user_agent | text nullable | |
| payload | longtext | |
| last_activity | integer | unix ts |

### `mejas` — master meja tanam
| Kolom | Tipe | Keterangan |
|---|---|---|
| id_meja | bigint PK | |
| meja | varchar | nama/kode meja |
| jumlah_lubang | integer | kapasitas |

### `tanamen` — jenis tanaman
| Kolom | Tipe | Keterangan |
|---|---|---|
| id_tanaman | bigint PK | |
| nama_tanaman | varchar | |
| id_meja | FK → mejas.id_meja nullable | meja bawaan |

### `sikluses` — durasi siklus tanam
| Kolom | Tipe | Keterangan |
|---|---|---|
| id_siklus | bigint PK | |
| id_tanaman | FK → tanamen.id_tanaman nullable | |
| nama_siklus | varchar | |
| waktu_siklus | integer | hari |

### `semais` — tahap 1 (Semai)
| Kolom | Tipe | Keterangan |
|---|---|---|
| id_semai | bigint PK | |
| id_tanaman | FK → tanamen | |
| id_siklus | FK → sikluses | |
| id_meja | FK → mejas (tambahan) | |
| jumlah_benih | integer | |
| tgl_awal_semai / tgl_akhir_semai | date | |
| status | enum | `proses` / `selesai` (default `proses`) |
| keterangan | text nullable | |
| benih_berhasil / benih_gagal | integer | default 0 |

Index: id_tanaman, id_siklus, id_meja

### `peremajaans` — tahap 2 (Peremajaan)
| Kolom | Tipe | Keterangan |
|---|---|---|
| id_peremajaan | bigint PK | |
| id_semai | FK → semais.id_semai | sumber pindah |
| id_meja | FK → mejas.id_meja | |
| jumlah_masuk | integer nullable | (tambahan) |
| benih_berhasil / benih_gagal | integer | |
| tgl_awal_peremajaan / tgl_akhir_peremajaan | date | |
| keterangan | text nullable | |

### `pendewasaans` — tahap 3 (Pendewasaan)
| Kolom | Tipe | Keterangan |
|---|---|---|
| id_pendewasaan | bigint PK | |
| id_peremajaan | FK → peremajaans.id_peremajaan | |
| id_meja | FK → mejas.id_meja | |
| jumlah_masuk | integer nullable | (tambahan) |
| tanaman_berhasil / tanaman_gagal | integer | |
| tgl_awal_pendewasaan / tgl_akhir_pendewasaan | date | |
| keterangan | text nullable | |

### `panens` — tahap 4 (Panen)
| Kolom | Tipe | Keterangan |
|---|---|---|
| id_panen | bigint PK | |
| id_pendewasaan | FK → pendewasaans.id_pendewasaan | |
| panen_berhasil / panen_gagal | integer | default 0 |
| tgl_panen | date | |
| keterangan | text nullable | |

### `monitorings` — log sensor ESP32 (polling)
| Kolom | Tipe | Keterangan |
|---|---|---|
| id | bigint PK | |
| waterTemp | float nullable | suhu air (°C) |
| ph | float nullable | pH air |
| tds | float nullable | TDS (ppm) |
| airTemp | float nullable | suhu udara (°C) |
| humidity | float nullable | kelembapan (%) |
| water_level | varchar nullable | status tandon |
| created_at / updated_at | timestamp | |

### `alert_logs` — log alert
| Kolom | Tipe | Keterangan |
|---|---|---|
| id | bigint PK | |
| type | varchar | tipe alert (solenoid, water_level, dsb) |
| value | varchar | nilai/pesan |
| created_at / updated_at | timestamp | |

### `sensor_thresholds` — ambang sensor (feed ke ESP32)
| Kolom | Tipe | Keterangan |
|---|---|---|
| id | bigint PK | |
| sensor | varchar unique | `waterTemp`, `ph`, `tds`, `airTemp`, `humidity` |
| min / max | float nullable | batas normal |
| updated_at | timestamp | |

### `water_controls` — state katup & mode
| Kolom | Tipe | Keterangan |
|---|---|---|
| id | bigint PK | |
| command | enum | `AUTO` / `FORCE_FILL` / `FORCE_STOP` (default `AUTO`) |
| mode | enum | `AUTO` / `MANUAL` (default `AUTO`) |
| valve_state | enum (tambahan) | `ON` / `OFF` — status fisik katup dari ESP32 |
| updated_at | timestamp | |

### `wa_settings` — setelan notifikasi WhatsApp
| Kolom | Tipe | Keterangan |
|---|---|---|
| id | bigint PK | |
| aktif | boolean | default false |
| api_key | varchar nullable | API key Fonnte |
| target | varchar nullable | nomor tujuan |
| updated_at | timestamp | |

## 4) Tabel infrastruktur Laravel
`password_reset_tokens`, `cache`, `cache_locks`, `jobs`, `job_batches`, `failed_jobs` — standar Laravel, tidak dimodifikasi.

## 5) Data seed (akun login)

| username | password | level | is_demo |
|---|---|---|---|
| admin | `@adminbersabda123` | admin | false |
| demo | (lihat DemoUserSeeder) | user | **true** |
| petani | `petani123` | petani | false |

Seed lain: `MejaSeeder`, `TanamanSeeder`, `SiklusSeeder`, `SemaiSeeder`, `PeremajaanSeeder`, `PendewasaanSeeder`, `PanenSeeder`, `SensorThresholdSeeder`, `WaterControlSeeder`.

## 6) Cara menjalankan ulang (lokal)

```bash
# 1. Pastikan PostgreSQL jalan
brew services start postgresql@17

# 2. Backend Laravel
cd ~/Documents/Vertonik-Smart-Farm
php artisan migrate --seed --force
php artisan serve --host=127.0.0.1 --port=8000
```

Login teruji: POST `/login` → redirect `/dashboard` ✅ (2026-10-14)
