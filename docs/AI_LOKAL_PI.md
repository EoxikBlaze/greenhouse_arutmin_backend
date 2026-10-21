# AI Lokal di Raspberry Pi — Asisten Keputusan Budidaya

Endpoint **`POST /api/ai/langkah-selanjutnya`** menjawab satu pertanyaan:
**"langkah apa yang sebaiknya diambil sekarang?"** — dengan membaca data nyata
dari database, lalu bertanya ke model AI lokal (**Ollama**) yang berjalan di
Raspberry Pi. Bila AI tidak tersedia, jawaban tetap keluar dari **aturan
heuristik transparan** (bukan error).

> Singkatnya: **AI opsional, keputusan selalu ada.**

---

## 1. Arsitektur ringkas

```
  Browser/SPA ──POST /api/ai/langkah-selanjutnya (Bearer JWT)──┐
                                                               ▼
                                                    ┌─────────────────────┐
  ESP32 ──sensor/alert──▶ PostgreSQL ◀──baca data── │  backend (Express)  │
                            (monitorings,           └─────────┬───────────┘
                             alert_logs, semais,               │
                             sikluses, panens,                 │  JSON ringkasan data
                             sensor_thresholds)                ▼
                                                    ┌─────────────────────┐
                                                    │ Ollama di Raspberry │
                                                    │ Pi :11434           │
                                                    │ model AI_MODEL      │
                                                    │ (qwen2.5:1.5b)  │
                                                    └─────────┬───────────┘
                                                              │ JSON {keputusan,
                                                              │ alasan, prioritas}
                     GAGAL (mati/timeout/JSON rusak)          │
        ┌─────────────────────────────────────────────────────┘
        ▼
  FALLBACK HEURISTIK (aturan dari ambang & durasi di DB) → respons tetap 200
```

Alur di dalam `src/routes/ai.js`:

1. **Ambil data nyata** — tahap (semai → peremajaan → pendewasaan), sensor
   terakhir (per meja bila `id_meja` dikirim), `alert_logs` yang belum
   di-acknowledge, `sensor_thresholds` (ambang), `sikluses.waktu_siklus`
   (durasi tahap), dan panen terakhir.
2. **Kirim ke Ollama** `POST {AI_OLLAMA_URL}/api/generate` (model
   `AI_MODEL`, timeout 30 detik) dengan instruksi membalas JSON
   `{"keputusan","alasan","prioritas"}`.
3. **Validasi ketat** — balasan harus JSON valid + field wajib terisi.
   Gagal → **heuristik**, dan respons menyebut alasannya di `fallback_karena`.

---

## 2. Cara pakai endpoint

| | |
|---|---|
| URL | `POST /api/ai/langkah-selanjutnya` |
| Proteksi | Header `Authorization: Bearer <TOKEN>` (role **admin** atau **petani**; akun demo → 403) |
| Body | `{}` (boleh kosong) atau `{"id_tanaman": 3}` / `{"id_meja": 8}` (opsional) |
| Timeout | 30 detik menunggu Ollama; setelah itu fallback heuristik |

### Contoh curl

```bash
# 1) login dulu untuk mendapatkan token
TOKEN=$(curl -s -X POST http://127.0.0.1:8000/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"ISI_PASSWORD"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')

# 2) tanyakan langkah selanjutnya
curl -s -X POST http://127.0.0.1:8000/api/ai/langkah-selanjutnya \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id_tanaman": 3}'
```

### Contoh respons (diambil dari server berjalan, Ollama MATI → heuristik)

```json
{
  "keputusan": "Tangani 51 alert yang masih terbuka sebelum kegiatan lain",
  "alasan": "Tangani 51 alert yang masih terbuka sebelum kegiatan lain — alert_logs: 51 alert belum di-acknowledge, terbaru: uji (x) 2026-10-14T22:44:51.000Z | Kurangi konsentrasi nutrisi / bilas (TDS di atas ambang) — TDS 1200 ppm di atas ambang 1000 ppm (sensor_thresholds) | Mulai siklus baru (semai) atau evaluasi hasil panen sebelumnya — seluruh tahap tercatat berstatus selesai; panen terakhir 2026-08-20 (20 berhasil)",
  "prioritas": "tinggi",
  "sumber": "heuristik",
  "model": null,
  "fallback_karena": "koneksi",
  "aturan": [
    "alert_logs terbuka → tangani alert dulu",
    "tds > max → perbaiki",
    "semua tahap selesai → mulai siklus baru"
  ],
  "ringkasan": {
    "filter": { "id_tanaman": "3", "id_meja": null },
    "sensor": { "ph": 6.5, "waterTemp": 26.9, "tds": 1200, "airTemp": 31, "humidity": 66, "water_level": "Sedang", "waktu": "2026-10-14T22:43:58.000Z", "cakupan": "global" },
    "ambang": { "ph": { "min": 5, "max": 7, "satuan": "pH" }, "tds": { "min": 50, "max": 1000, "satuan": "ppm" } },
    "alert": { "total": 51, "terbaru": [ ... ] },
    "tahap": [ { "tahap": "semai", "status": "selesai", "durasi_hari": 7, "sisa_hari": null } ],
    "panen": { "tgl_panen": "2026-08-20", "panen_berhasil": 20, "total_panen": 2 }
  },
  "generated_at": "2026-10-21T...Z"
}
```

Ketika **Ollama hidup dan jawabannya valid**, dua field ini berubah:

```json
{ "sumber": "ollama", "model": "qwen2.5:1.5b", "fallback_karena": null }
```

### Arti field

| Field | Keterangan |
|---|---|
| `keputusan` | Satu kalimat tindakan yang disarankan. |
| `alasan` | Semua temuan yang mendasarinya (disertai angka & sumbernya). |
| `prioritas` | `tinggi` / `sedang` / `rendah`. |
| `sumber` | `ollama` = jawaban dari model AI; `heuristik` = jawaban dari aturan. |
| `model` | Nama model yang dipakai (`qwen2.5:1.5b`); **`null` saat heuristik** (tidak ada LLM yang dipakai). |
| `fallback_karena` | `null` bila pakai Ollama; kalau heuristik: `koneksi`, `timeout`, `respons_ollama_tidak_valid`, atau `json_invalid`. |
| `aturan` | Daftar aturan heuristik yang terpicu (transparan, bisa diaudit). |
| `ringkasan` | Data nyata dari DB yang dipakai menilai (sensor, ambang, alert, tahap, panen). |

---

## 3. Aturan heuristik (fallback) — transparan & berbasis data

Urutan prioritas (yang pertama terpenuhi menjadi `keputusan`, semua temuan tetap
ditulis di `alasan`):

| # | Kondisi (dari data DB) | Sumber angka | Keputusan |
|---|---|---|---|
| 1 | Ada `alert_logs` dengan `acknowledged` ≠ true | tabel `alert_logs` | Tangani alert dulu |
| 2 | pH di luar `sensor_thresholds.ph` | tabel `sensor_thresholds` | Perbaiki pH |
| 3 | Suhu air di luar `sensor_thresholds.waterTemp` | tabel `sensor_thresholds` | Aktifkan pendingin / naikkan aerasi |
| 4 | TDS di luar `sensor_thresholds.tds` | tabel `sensor_thresholds` | Cek nutrisi / kurangi konsentrasi |
| 5 | Suhu udara / kelembapan di luar ambangnya | tabel `sensor_thresholds` | Atur ventilasi |
| 6 | Tahap berjalan **melewati** durasi | `sikluses.waktu_siklus` + tanggal tahap | Tutup tahap & siapkan tahap berikutnya |
| 7 | Tahap berjalan **mendekati** durasi (sisa ≤ 20% durasi, min. 1 hari) | `sikluses.waktu_siklus` + tanggal tahap | Siapkan tahap berikutnya |
| 8 | Semua tahap berstatus `selesai` | tabel `semais`/`peremajaans`/`pendewasaans` | Mulai siklus baru / evaluasi panen |
| 9 | Tidak ada temuan | — | Pantau rutin |

Ambang & durasi **diambil dari database**, bukan angka mati di kode. Konstanta
cadangan di `src/routes/ai.js` (`PAGAR_DARURAT`) hanya dipakai bila baris
ambang/durasi tidak ada di tabel.

---

## 4. Instalasi di Raspberry Pi (step-by-step)

Prasyarat: Raspberry Pi OS **64-bit** (ARM64), Pi 4/5 dengan RAM **4–8 GB**,
backend + PostgreSQL berjalan, dan koneksi internet (sekali saja untuk unduh).

### Cara cepat (satu script)

```bash
cd backend-nodejs
chmod +x deploy-pi/setup-ai.sh
./deploy-pi/setup-ai.sh
```

Script akan: (0) cek arsitektur & RAM, (1) instal Ollama resmi
`curl -fsSL https://ollama.com/install.sh | sh`, (2) `systemctl enable --now ollama`,
(3) verifikasi `curl http://127.0.0.1:11434/api/version`, (4) `ollama pull qwen2.5:1.5b`,
(5) uji jawaban model, (6) cek RAM/swap + rekomendasi swap file/zram, (7)
menampilkan baris `.env` yang perlu diisi.

### Cara manual (bila ingin mengerjakan sendiri)

```bash
# 1. instal Ollama (resmi)
curl -fsSL https://ollama.com/install.sh | sh

# 2. nyalakan layanannya & otomatis menyala saat Pi dinyalakan
sudo systemctl enable --now ollama
systemctl status ollama --no-pager          # harus: active (running)

# 3. verifikasi endpoint hidup
curl -s http://127.0.0.1:11434/api/version  # {"version":"..."}
curl -s http://127.0.0.1:11434/api/tags     # daftar model (awalnya kosong)

# 4. unduh model ringan (sekali saja, ±1 GB)
ollama pull qwen2.5:1.5b

# 5. uji model
curl -s http://127.0.0.1:11434/api/generate \
  -d '{"model":"qwen2.5:1.5b","prompt":"Balas JSON: {\"ok\":true}","stream":false}'
```

### Konfigurasi backend (berkas `.env` di root backend)

```
AI_MODEL=qwen2.5:1.5b
AI_OLLAMA_URL=http://127.0.0.1:11434
```

Kalau backend dan Ollama di Pi yang sama, **nilai default sudah benar** —
kedua baris ini opsional. Restart backend setelah mengubah `.env`:

```bash
pkill -f 'node src/index.js'   # atau: lsof -ti tcp:8000 | xargs kill
npm start
```

> Ollama di komputer lain di jaringan: set `AI_OLLAMA_URL=http://IP_PI:11434`
> **dan** jalankan Ollama dengan `OLLAMA_HOST=0.0.0.0` agar bisa diakses dari luar.

---

## 5. Cara ganti model

```bash
ollama pull qwen2.5:1.5b        # unduh model lain
ollama list                     # lihat model yang terpasang
ollama rm qwen2.5:1.5b      # (opsional) hapus model lama
```

Lalu ubah di `.env`:

```
AI_MODEL=qwen2.5:1.5b
```

dan restart backend.

Rekomendasi ukuran RAM:

| RAM Pi | Model | Catatan |
|---|---|---|
| 2 GB | `qwen2.5:0.5b` | Model 1,5B berisiko ter-kill OOM. |
| 4 GB | `qwen2.5:1.5b` (default) | Sediakan swap 2 GB atau zram. |
| 8 GB | `qwen2.5:1.5b` / `qwen2.5:3b` | Bisa naik ke 3B untuk jawaban lebih rapi. |

Catatan: `qwen2.5:1.5b` adalah model *reasoning* — kadang panjang
berpikirnya sehingga lambat di Pi. Alternatif yang lebih cepat & ringan:
`qwen2.5:1.5b` atau `smollm2:135m` (sangat ringan, kualitas seadanya).

---

## 6. Troubleshooting

| Gejala | Penyebab | Penanganan |
|---|---|---|
| Respons `sumber:"heuristik"`, `fallback_karena:"koneksi"` | Ollama mati / belum terpasang | `sudo systemctl start ollama` lalu `curl -s http://127.0.0.1:11434/api/version` |
| `fallback_karena:"timeout"` (>30 dtk) | Model terlalu berat untuk RAM Pi | Turunkan model (lihat tabel RAM) atau tambah swap/zram |
| `fallback_karena:"json_invalid"` | Model menjawab proses berpikir, bukan JSON | Ganti model (DeepSeek-R1 sering begitu) → `qwen2.5:1.5b`; endpoint tetap aman |
| `curl: (7) Failed to connect` | Port salah / Ollama bind ke alamat lain | Cek `AI_OLLAMA_URL` di `.env`, cek `ss -ltnp \| grep 11434` |
| Respons lambat (>10 dtk) walaupun sukses | Muat model pertama kali di RAM kecil | Biarkan; request berikutnya lebih cepat (model sudah termuat) |
| Pi sering mati sendiri (OOM) | RAM kurang untuk model + Postgres + backend | Tambah swap 2 GB / zram, atau pakai model 0,5B |
| `403 Mode demo tidak boleh memakai asisten AI.` | Token demo | Login dengan akun admin/petani |
| `401 Tidak terautentikasi.` | Token tidak dikirim/kedaluwarsa (12 jam) | Login ulang, kirim header `Authorization: Bearer <TOKEN>` |

**Penting:** endpoint **tidak pernah** error 500 hanya karena AI bermasalah —
selama database bisa dibaca, jawaban selalu keluar (dari heuristik bila perlu).

Cek cepat dari mana jawaban berasal:

```bash
curl -s -X POST http://127.0.0.1:8000/api/ai/langkah-selanjutnya \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["sumber"], d["model"], d["fallback_karena"])'
```

---

## 7. Pengujian

```bash
node --test test/integration/ai.test.js
```

Meng cover: 401 tanpa token, 403 akun demo, 422 id tidak valid, 200 admin +
fallback heuristik (Ollama dipancing mati), 200 petani, serta jalur Ollama
penuh memakai server mock (balasan valid → `sumber:"ollama"`; balasan rusak →
heuristik `fallback_karena:"json_invalid"`).

File terkait:

- `src/routes/ai.js` — endpoint + heuristik + pemanggilan Ollama
- `src/index.js` — mount `app.use('/api/ai', ai)`
- `src/config.js` — `AI_MODEL`, `AI_OLLAMA_URL`
- `deploy-pi/setup-ai.sh` — instalasi Ollama di Pi
- `test/integration/ai.test.js` — uji integrasi
