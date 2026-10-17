# DIAGRAM ALUR BACKEND — GARAP

Tiga diagram Mermaid untuk memahami backend GARAP (Express 4 + PostgreSQL 17).
Nama tabel & kolom diambil langsung dari `database/schema.sql` (13 tabel domain, 10 FK).
Render otomatis di GitHub / VS Code / Typora.

---

## 1. Arsitektur umum — dari klien sampai database

```mermaid
flowchart LR
    subgraph KL ["KLIEN"]
        B["Browser SPA<br/>React · :5173<br/>Authorization: Bearer JWT"]
        F["Flutter / polling<br/>GET /api/latest-sensor tiap 5 dtk"]
        E["ESP32<br/>POST /api/save-sensor<br/>header X-API-KEY"]
    end

    subgraph EX ["EXPRESS — src/index.js"]
        G1["Guard 1 · body JSON<br/>maks 256 KB → 400 bila rusak"]
        G2["Guard 2 · header keamanan<br/>nosniff · DENY · no-store"]
        G3["Guard 3 · rate limit / IP<br/>GET 300 · tulis 60 · login 10 → 429"]
        G4["Guard 4 · auth<br/>JWT (401) · role (403) · X-API-KEY (403)"]
        RT["Layer routes — 12 modul<br/>auth · monitoring · dashboard · tanam ·<br/>master · tahap · watercontrol · laporan ·<br/>user · profil · notifWa"]
        G1 --> G2 --> G3 --> G4 --> RT
    end

    subgraph CA ["CACHE — src/cache.js (in-memory TTL)"]
        C1["latest-sensor<br/>2 detik"]
        C2["dashboard<br/>5 detik"]
        C3["thresholds<br/>60 detik"]
    end

    subgraph DB ["DATABASE — src/db.js"]
        POOL["Pool pg<br/>max 50 koneksi<br/>timeout 10 dtk"]
        SQL["q() / one()<br/>SQL parameterized $1,$2"]
        PG[("PostgreSQL 17<br/>vertonik_smartfarm<br/>13 tabel domain · 35 index")]
        POOL --> SQL --> PG
    end

    B & F & E --> G1
    RT -->|"baca data"| CA
    CA -->|hit| RESP["Respons JSON<br/>200 / 201"]
    CA -->|miss| POOL
    RT -->|"tulis data"| POOL
    RT --> RESP
    PG -.->|"isi ulang cache"| CA

    classDef kl fill:#083344,stroke:#22d3ee,color:#fff
    classDef gd fill:#450a0a,stroke:#fb7185,color:#fff
    classDef rt fill:#064e3b,stroke:#34d399,color:#fff
    classDef db fill:#2e1065,stroke:#a78bfa,color:#fff
    class B,F,E kl
    class G1,G2,G3,G4 gd
    class RT,C1,C2,C3,RESP rt
    class POOL,SQL,PG db
```

**Penjelasan:** setiap klien melewati 4 guard berurutan sebelum masuk ke layer routes;
routes yang butuh data mengecek cache dulu (2/5/60 detik) baru jatuh ke pool koneksi
PostgreSQL, sehingga polling ribuan klien hampir tidak membebani database.

---

## 2. Jalur TULIS — dari body JSON sampai baris tersimpan

```mermaid
flowchart TD
    IN["Body JSON masuk<br/>POST/PUT/DELETE · maks 256 KB"] --> GD{"Guard lolos?<br/>rate limit · JWT · role · demoGuard"}
    GD -->|tidak| ERR1["401 / 403 / 429"]
    GD -->|ya| WL{"routes/_crud.js — whitelist kolom<br/>hanya kolom yang terdaftar di ikuti"}
    WL -->|"ada kolom di luar daftar"| WARN["console.warn (kolom dibuang)<br/>+ 422 bila TIDAK ADA satupun yang cocok"]
    WL -->|"semua cocok"| PARAM["Bangun query parameterized<br/>INSERT INTO tabel (kolom) VALUES ($1,$2,...)<br/>param dari req.body — bukan string SQL"]
    WARN --> PARAM
    PARAM --> SEQ["Sequence menghasilkan id baru<br/>mis. semais_id_semai_seq → id_semai"]
    SEQ --> INS{"Simpan baris"}
    INS -->|"duplikat / sequence < max(id)"| FAIL["ERROR duplicate key<br/>→ error handler → 500 generik<br/>⚠ titik gagal paling sering pasca-restore dump"]
    INS -->|sukses| RET["RETURNING kolom eksplisit<br/>users: id, username, email, level, is_demo<br/>mejas: id_meja, meja, jumlah_lubang, ..."]
    RET --> OUT["201 { status:true, data:{...} }<br/>id baru ikut terkirim ke klien"]
    OUT -.->|"baris demo: expires_at +1 jam"| PURGE["demoPurge() hapus otomatis 1×/mnt"]

    FAIL -.->|"perbaikan: psql -f scripts/fix-sequences.sql<br/>(otomatis di scripts/restore.sh)"| SEQ

    classDef ok fill:#064e3b,stroke:#34d399,color:#fff
    classDef err fill:#450a0a,stroke:#fb7185,color:#fff
    class IN,GD,WL,PARAM,SEQ,INS,RET,OUT,PURGE,WARN ok
    class ERR1,FAIL err
```

**Penjelasan:** kolom difilter whitelist dulu (kolom tak dikenal dibuang + dicatat log), lalu
di-INSERT memakai parameter $1,$2 — id datang dari sequence, dan `RETURNING` daftar kolom
eksplisit (tanpa `password`/`api_key`) yang dikirim balik. Satu titik gagal diketahui:
bila **sequence < max(id)** (terjadi setelah restore dump tanpa `fix-sequences`) →
`duplicate key` → **500**.

---

## 3. Relasi tabel (ERD) — 13 tabel, 10 foreign key

```mermaid
erDiagram
    users {
        bigint id PK
        varchar username UK
        varchar email UK
        varchar password "bcrypt cost 12"
        varchar level "admin/petani/user"
        boolean is_demo
    }
    mejas {
        bigint id_meja PK
        varchar meja
        int jumlah_lubang
        timestamp expires_at
    }
    tanamen {
        bigint id_tanaman PK
        varchar nama_tanaman
        bigint id_meja FK
    }
    sikluses {
        bigint id_siklus PK
        bigint id_tanaman FK
        varchar nama_siklus
        int waktu_siklus
    }
    semais {
        bigint id_semai PK
        bigint id_tanaman FK
        bigint id_siklus FK
        bigint id_meja FK
        int jumlah_benih
        date tgl_awal_semai
        varchar status
    }
    peremajaans {
        bigint id_peremajaan PK
        bigint id_semai FK
        bigint id_meja FK
        date tgl_awal_peremajaan
    }
    pendewasaans {
        bigint id_pendewasaan PK
        bigint id_peremajaan FK
        bigint id_meja FK
        date tgl_awal_pendewasaan
    }
    panens {
        bigint id_panen PK
        bigint id_pendewasaan FK
        int panen_berhasil
        date tgl_panen
    }
    monitorings {
        bigint id PK
        double waterTemp
        double ph
        double tds
        double airTemp
        double humidity
        varchar water_level
    }
    alert_logs {
        bigint id PK
        varchar type
        varchar value
    }
    sensor_thresholds {
        bigint id PK
        varchar sensor UK
        double min
        double max
    }
    water_controls {
        bigint id PK
        varchar command
        varchar mode
        varchar valve_state
    }
    wa_settings {
        bigint id PK
        boolean aktif
        text api_key "AES-256"
        varchar target
    }

    mejas ||--o{ tanamen : "id_meja · SET NULL"
    mejas ||--o{ semais : "id_meja · SET NULL"
    mejas ||--o{ peremajaans : "id_meja · SET NULL"
    mejas ||--o{ pendewasaans : "id_meja · SET NULL"
    tanamen ||--o{ sikluses : "id_tanaman · SET NULL"
    tanamen ||--o{ semais : "id_tanaman · SET NULL"
    sikluses ||--o{ semais : "id_siklus · SET NULL"
    semais ||--o{ peremajaans : "id_semai · SET NULL"
    peremajaans ||--o{ pendewasaans : "id_peremajaan · SET NULL"
    pendewasaans ||--o{ panens : "id_pendewasaan · ON DELETE RESTRICT"
```

**Penjelasan:** rantai utamanya `mejas → tanamen → sikluses → semais → peremajaans →
pendewasaans → panens`; 9 dari 10 relasi memakai `SET NULL` (hapus induk → tautan putus,
data anak tetap), dan `panens → pendewasaans` memakai **`RESTRICT`** — pendewasaan tidak
bisa dihapus selama masih ada panen, karena panen adalah data historis.

> **⚠ Catatan penting (beda dengan instruksi awal):** relasi `panens → pendewasaans`
> semula `ON DELETE CASCADE`, tetapi **sudah diubah ke `RESTRICT`** lewat migrasi
> `database/migrations/2026-10-17_panens_fk_restrict.sql` (tugas perbaikan sebelumnya,
> handler DELETE kini membalas `409` yang ramah). Diagram di atas menampilkan kondisi
> **terkini**. Bila memang mau dikembalikan ke CASCADE, jalankan migrasi balikannya dan
> saya sesuaikan diagramnya.

**Enam tabel tanpa FK:** `users`, `monitorings`, `alert_logs`, `sensor_thresholds`,
`water_controls`, `wa_settings` (berdiri sendiri; data perangkat dihubungkan lewat
rancangan `devices` — lihat `docs/ARSITEKTUR_PI_2ESP32.md`).
