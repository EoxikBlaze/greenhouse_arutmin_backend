# README — CRON Retensi & Rollup (Skema V2)

> **STATUS: DRAFT.** Semua berkas SQL di `backend-nodejs/database/` yang ber-*header*
> DRAFT **belum dieksekusi ke live `vertonik_smartfarm`** dan **butuh persetujuan user**
> sebelum dijalankan di production. Live hanya boleh menerima perintah SELECT untuk
> pemeriksaan; DDL/DML = izin user dulu. Uji selalu di DB scratch (bagian 6).
>
> Sumber keputusan: `docs/RANCANGAN_DB_V2.md` §12–§13 (retensi **60 hari** mentah,
> rollup **2 tahun**, granularitas **hourly**, audit/laporan **365 hari**) — tercatat
> dieksekusi di `docs/VERIFIKASI/EKSEKUSI_V2.md` §5.

---

## 1. Daftar tugas cron

| # | Berkas | Isi | Jadwal (cron expression) | Kapan |
|---|--------|-----|--------------------------|-------|
| 1 | `database/cron_rollup.sql` | `fn_rollup_readings()` 2 jam terakhir → `sensor_readings_hourly`, + ringkasan | `5 * * * *` | tiap jam, menit ke-05 |
| 2 | `database/cron_retensi.sql` | `fn_pensiun_readings(60)` (DROP partisi mentah), buat partisi +30/+60 hari, hapus rollup > 2 tahun & audit/laporan > 365 hari | `7 2 1 * *` | tiap tanggal 1, pukul 02:07 |
| 3 | `database/backfill_monitorings_ke_readings.sql` | INSERT … SELECT 12 baris `monitorings` → `sensor_readings` (`sumber='IMPORT'`, idempoten) | **manual, sekali jalan** | fase 2, setelah izin user |
| 4 | `database/reindex_monitorings.sql` | `REINDEX` + `ANALYZE` `monitorings` & partisi `sensor_readings` | `23 3 1 * *` (opsional) | tiap tanggal 1, pukul 03:23 |
| 5 | `database/index_laporan.sql` | 2 index baru `CONCURRENTLY` + saran drop index ganda (dikomentari) | **manual, sekali jalan** | setelah EXPLAIN before/after |

Kenapa rollup tiap jam sedangkan retensi bulanan: partisi `sensor_readings` bersifat
**bulanan**, jadi membuang data hanya masuk akal sebulan sekali — memanggil
`fn_pensiun_readings(60)` tiap hari hanya membuang 0 partisi (perilaku normal, bukan
gagal). Rollup hourly justru harus sering supaya chart > 24 jam selalu punya bahan.

Menit 5 dan menit 7 dipilih supaya job tidak berbarengan dengan menit-00 (jam sibuk
backup/kolam koneksi) dan memberi waktu tulisan jam terakhir masuk dulu.

---

## 2. Prasyarat (sekali pasang)

1. **Skema V2 sudah terpasang** — 4 fungsi (`fn_partisi_readings_bulanan`,
   `fn_pensiun_readings`, `fn_rollup_readings`, `fn_override_aktif`) dan 12 partisi
   `sensor_readings` wajib ada. Semua skrip di atas memeriksanya sendiri dan
   berhenti dengan pesan jelas bila belum (tidak ada kerusakan separuh jalan —
   seluruh skrip satu transaksi).
2. **Kredensial tanpa password di baris perintah** (baris cron sering masuk ke log /
   `ps`). Pakai `~/.pgpass`:
   ```
   127.0.0.1:5432:vertonik_smartfarm:vertonik:PASSWORD_ANDA
   ```
   Simpan sebagai `~/.pgpass` (atau `/home/USERNAME/.pgpass`), lalu `chmod 600 ~/.pgpass`.
   Alternatif: `PGPASSWORD` / `PGSERVICE` lewat berkas terpisah yang di-`source`.
3. **Timezone konsisten.** Kolom memakai `timestamp without time zone` yang dibaca
   aplikasi sebagai WITA, dan skrip memakai `now()`. Jalankan sekali:
   `psql -X -c "SHOW timezone" -c "SELECT now()"` — timezone DB harus WITA; pastikan
   jam cron host juga WITA (`date`), kalau tidak geser menit/jam jadwal di bawah.
4. **Hak akses**: role yang dipakai cron harus pemilik/`DELETE` pada partisi
   `sensor_readings_*` (role `vertonik` memilikinya). Job retensi gagal dengan
   `permission denied` bila memakai role readonly.

---

## 3. Cara pasang di hosting TANPA terminal (panel web)

Semua panel punya menu cron dengan 4 kolom: menit, jam, hari bulan, bulan, hari minggu,
lalu **Command**. Isi kolom-kolom dengan angka dari tabel §1, dan Command dengan baris
perintah di bawah. Bila ada pilihan "crontab path / email notification", isi email
supaya kegagalan (exit code ≠ 0) terkirim.

### 3.1 Perintah psql (pilihan utama — tidak butuh PHP/Node)

> **Sekali saja sebelum cron pertama:** jalankan `mkdir -p logs` dari folder repo —
> redirect `>> .../logs/*.log` akan gagal `No such file` bila folder belum ada.
> Sesuaikan juga path `psql` (cek `which psql` di server; contoh pertama memakai
> `/opt/homebrew/bin/psql` milik macOS — di hosting umumnya `/usr/bin/psql`).

Rollup tiap jam:

```
5 * * * * /opt/homebrew/bin/psql -X -v ON_ERROR_STOP=1 -q -h 127.0.0.1 -U vertonik -d vertonik_smartfarm -f /path/ke/repo/backend-nodejs/database/cron_rollup.sql >> /path/ke/repo/backend-nodejs/logs/cron_rollup.log 2>&1
```

Retensi bulanan (tgl 1, 02:07):

```
7 2 1 * * /usr/bin/psql -X -v ON_ERROR_STOP=1 -q -h 127.0.0.1 -U vertonik -d vertonik_smartfarm -f /path/ke/repo/backend-nodejs/database/cron_retensi.sql >> /path/ke/repo/backend-nodejs/logs/cron_retensi.log 2>&1
```

Catatan kolom `psql`:

| Flag | Fungsi |
|------|--------|
| `-X` | abaikan `.psqlrc` (konsisten antar hosting) |
| `-v ON_ERROR_STOP=1` | **berhenti + exit ≠ 0 saat ada error SQL** — tanpa ini psql tetap "sukses" padahal skrip gagal |
| `-q` | senyap; hanya `RAISE NOTICE`/hasil yang dicetak |
| `-f path` | jalankan berkas SQL |
| `>> log 2>&1` | semua keluaran (termasuk `stderr` error) masuk satu log |

Ganti `/path/ke/repo` dengan path absolut repo di server (lihat
`backend-nodejs/.env` untuk `DATABASE_URL` host/db/user; **jangan** tempelkan password
di command — pakai `~/.pgpass`, §2.2).

Bentuk alternatif memakai connection string (bila `-h/-U/-d` tidak didukung panel):

```
5 * * * * /usr/bin/psql "postgresql://vertonik@127.0.0.1:5432/vertonik_smartfarm" -X -v ON_ERROR_STOP=1 -q -f /path/database/cron_rollup.sql >> /path/logs/cron_rollup.log 2>&1
```

Bentuk satu-baris `psql -c` (bila panel hanya menerima satu perintah pendek):

```
5 * * * * /usr/bin/psql -X -v ON_ERROR_STOP=1 -q -d vertonik_smartfarm -c "SELECT fn_rollup_readings((date_trunc('hour', now()) - interval '2 hours')::timestamp, date_trunc('hour', now())::timestamp)" >> /path/logs/cron_rollup.log 2>&1

7 2 1 * * /usr/bin/psql -X -v ON_ERROR_STOP=1 -q -d vertonik_smartfarm -c "SELECT fn_pensiun_readings(60)" -c "SELECT fn_partisi_readings_bulanan(now()::date + 30)" >> /path/logs/cron_retensi.log 2>&1
```

> Catatan: bentuk `-c` di atas memanggil fungsi yang sama, tetapi **tanpa** transaksi
> maupun guard prasyarat. Untuk production, utamakan `-f cron_retensi.sql`.

**Menit khusus panel shared hosting** (bila kolom "Minute" memakai dropdown
`*/5`, `Daily`, …): pilih `Common Task → Daily` lalu isi jamnya, atau pakai
"Custom" dengan format 5 kolom di atas. DirectAdmin/CyberPanel/Plesk sama saja —
yang penting format 5 kolom standar crontab.

**Contoh panel cPanel (cPanel → Cron Jobs):**
1. Minute: `5` · Hour: `*` · Day: `*` · Month: `*` · Weekday: `*` → Command (rollup).
2. Minute: `7` · Hour: `2` · Day: `1` · Month: `*` · Weekday: `*` → Command (retensi).
3. Set "Cron Email" ke email Anda (default panel mengirim output & error).

### 3.2 Perintah artisan (bila backend dipasang sebagai aplikasi PHP)

Repo ini adalah **Node.js** (`backend-nodejs` — `npm start`), jadi `php artisan`
tidak tersedia di sini. Bagian ini disediakan untuk hosting lama / instalasi Laravel
yang masih memakai `vertonik_smartfarm` (lihat `docs/DB_SCHEMA.md` baris 203–204).

**Opsi A — tanpa command khusus (paling cepat):** daftarkan task di
`routes/console.php` (Laravel 11+) atau `app/Console/Kernel.php` (Laravel ≤10):

```php
// routes/console.php
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schedule;

Schedule::call(function () {
    DB::select('SELECT fn_rollup_readings(?, ?)', [
        date('Y-m-d H:00:00', strtotime('-2 hours')),
        date('Y-m-d H:00:00'),
    ]);
})->hourlyAt(5)->name('rollup-sensor')->withoutOverlapping();

Schedule::call(function () {
    DB::transaction(function () {
        DB::select('SELECT fn_partisi_readings_bulanan(?)', [date('Y-m-d', strtotime('+30 days'))]);
        DB::select('SELECT fn_pensiun_readings(60)');
        DB::statement("DELETE FROM sensor_readings_hourly WHERE bucket_start < now() - interval '2 years'");
        DB::statement("DELETE FROM audit_logs      WHERE terjadi_pada < now() - interval '365 days'");
        DB::statement("DELETE FROM report_logs     WHERE created_at  < now() - interval '365 days'");
    });
})->monthlyOn(1, '2:07')->name('retensi-sensor')->withoutOverlapping();
```

Lalu pasang **satu** baris crontab di panel (scheduler Laravel = tiap menit):

```
* * * * * cd /path/ke/app && php artisan schedule:run >> /path/ke/app/storage/logs/schedule.log 2>&1
```

**Opsi B — command khusus** (bila ingin task terpisah di `app/Console/Commands/`):

```
5 * * * * cd /path/ke/app && php artisan db:rollup-sensor  >> storage/logs/cron_rollup.log 2>&1
7 2 1 * * cd /path/ke/app && php artisan db:retensi-sensor >> storage/logs/cron_retensi.log 2>&1
```

Pola yang sama berlaku untuk panel berbasis Node bila kelak ada scheduler sendiri:
yang dibutuhkan hanyalah perintah `psql -X -v ON_ERROR_STOP=1 -f <berkas>` di atas.

### 3.3 Verifikasi pemasangan

- Cek crontab (butuh shell): `crontab -l`
- Tanpa shell: jalankan perintah dari bagian §3.1 di "Run a Command" / `psql` web admin
  (phpPgAdmin/pgAdmin) dan pastikan exit 0 + muncul baris `partisi_dipensiunkan` /
  `baris_rollup_ditulis`.
- Uji nyata pertama: jalankan `cron_rollup.sql` manual (tanpa menunggu jam) — aman
  karena idempoten; ulangi dua kali, hasil kedua identik.

---

## 4. Log

| Item | Nilai yang disarankan |
|------|-----------------------|
| Lokasi | `backend-nodejs/logs/cron_rollup.log` & `logs/cron_retensi.log` (pola `*.log` sudah masuk `.gitignore` root repo, jadi tak ikut ter-commit) |
| Format | `RAISE NOTICE` psql (`NOTICE:  ...`) + ringkasan akhir (`partisi_dipensiunkan`, `baris_rollup_ditulis`, `baris_mentah`, dst.) |
| Rotasi | `logrotate` bila ada shell; kalau tidak, pakai perintah cron tambahan `0 0 1 * * mv -f logs/cron_rollup.log logs/cron_rollup.$(date +\%F).log` (peringatan: `\%` wajib di-escape di crontab) |
| Deteksi gagal | Tandai `ON_ERROR_STOP=1` (exit ≠ 0). Di panel dengan email cron, error otomatis terkirim; tanpa email, cek log mingguan dengan `grep -iE "error|exception|failed" logs/cron_*.log` |
| Retensi log | log cron juga butuh umur — simpan maks 3 bulan (bagian §1 nomor 4 pola sama) |

Contoh isi log yang **sehat**:

```
NOTICE:  prasyarat retensi OK (partisi=12, fungsi=2)
NOTICE:  partisi untuk rentang backfill siap
 partisi_dipensiunkan
-----------------------
                     1
```

`partisi_dipensiunkan = 0` pada bulan berarti memang belum ada partisi yang berumur
60 hari — **normal**, bukan kegagalan. Yang jadi masalah adalah baris `ERROR:`.

---

## 5. Jadwal ringkas (copy-paste crontab)

```
# Vertonik Smartfarm — cron DB V2 (DRAFT, aktifkan setelah persetujuan user)
5 * * * *   /usr/bin/psql -X -v ON_ERROR_STOP=1 -q -d vertonik_smartfarm -f /path/database/cron_rollup.sql   >> /path/logs/cron_rollup.log 2>&1
7 2 1 * *   /usr/bin/psql -X -v ON_ERROR_STOP=1 -q -d vertonik_smartfarm -f /path/database/cron_retensi.sql  >> /path/logs/cron_retensi.log 2>&1
23 3 1 * *  /usr/bin/psql -X -v ON_ERROR_STOP=1 -q -d vertonik_smartfarm -f /path/database/reindex_monitorings.sql >> /path/logs/cron_reindex.log 2>&1
# backfill & index_laporan: SEKALI JALAN, manual — jangan dipasang sebagai cron
```

---

## 6. Uji di DB scratch (WAJIB sebelum live)

Aturan: **live `vertonik_smartfarm` = read-only** (SELECT saja). Semua DDL/DML diuji di
`vertonik_scratch_sql` yang di-restore dari dump live, lalu di-DROP.

```bash
DBURL="postgresql://vertonik@127.0.0.1:5432"     # password via ~/.pgpass
createdb -h 127.0.0.1 -U vertonik vertonik_scratch_sql
pg_dump -h 127.0.0.1 -U vertonik -d vertonik_smartfarm --schema-only \
        --no-owner --no-privileges -Fc -f /tmp/scratch_v2.dump
pg_restore -d vertonik_scratch_sql --no-owner --no-privileges /tmp/scratch_v2.dump
# isi minimal utk menguji backfill (data live -> scratch; live tetap read-only):
pg_dump -h 127.0.0.1 -U vertonik -d vertonik_smartfarm --data-only \
        --no-owner -t monitorings -t mejas -f /tmp/seed.sql
psql -X -v ON_ERROR_STOP=1 -d vertonik_scratch_sql -f /tmp/seed.sql

cd backend-nodejs/database
psql -X -v ON_ERROR_STOP=1 -d vertonik_scratch_sql -f backfill_monitorings_ke_readings.sql  # run 1 (default): 0 baris — semua id_meja NULL
psql -X -v ON_ERROR_STOP=1 -v p_id_meja_default=3 -d vertonik_scratch_sql -f backfill_monitorings_ke_readings.sql  # run 2: INSERT 0 12
psql -X -v ON_ERROR_STOP=1 -v p_id_meja_default=3 -d vertonik_scratch_sql -f backfill_monitorings_ke_readings.sql  # run 3: INSERT 0 0 (idempoten)
psql -X -v ON_ERROR_STOP=1 -d vertonik_scratch_sql -f cron_rollup.sql
psql -X -v ON_ERROR_STOP=1 -d vertonik_scratch_sql -f reindex_monitorings.sql
psql -X -v ON_ERROR_STOP=1 -d vertonik_scratch_sql -f index_laporan.sql
psql -X -v ON_ERROR_STOP=1 -d vertonik_scratch_sql -f cron_retensi.sql   # partisi 12 -> 11 (yg 60 hri), run 2 = 0

dropdb -h 127.0.0.1 -U vertonik vertonik_scratch_sql
```

Backfill pada tabel berisi 12 baris `monitorings` yang seluruhnya `id_meja IS NULL`
(7 `created_at` berbeda) — jadi secara default `NOTHING` ikut terimpor kecuali
`p_id_meja_default` diisi:

```bash
# tanpa pemetaan (default) : 0 baris masuk, 12 dilewati — sesuai dokumen §fase 2
psql -X -v ON_ERROR_STOP=1 -d vertonik_scratch_sql -f backfill_monitorings_ke_readings.sql
# dengan pemetaan ke meja (HANYA bila user menyetujui meja tujuan)
psql -X -v ON_ERROR_STOP=1 -v p_id_meja_default=3 -d vertonik_scratch_sql -f backfill_monitorings_ke_readings.sql
```

Bukti tiap run ada di keluaran `baris_baru_terinsert`, `belum_tercatat` (harus 0) dan
`sensor_readings` per `sumber`.

---

## 7. Checklist persetujuan sebelum eksekusi live

- [ ] User menyetujui retensi **60 hari / 2 tahun / 365 hari** (§12 butir 1 & 5).
- [ ] User menyetujui **pemetaan `monitorings.id_meja` NULL** (nilai default: *lewati*
      baris; alternatif: isi `p_id_meja_default` ke meja tujuan).
- [ ] User menyetujui **2 index baru** di `index_laporan.sql` (dan apakah drop 2 index
      ganda `monitorings_created_at_index` / `alert_logs_created_at_index`).
- [ ] Backup terbaru `pg_dump -Fc` tersedia (pola: `docs/VERIFIKASI/EKSEKUSI_V2.md` §1).
- [ ] Backup dulu **sebelum** `reindex_monitorings.sql` bila ukuran tabel sudah besar
      (lock singkat; bila > ratusan MB gunakan `CONCURRENTLY`).
- [ ] Live diverifikasi dengan **SELECT saja** sebelum & sesudah (jumlah tabel, jumlah
      partisi, rowcount) — tanpa DDL/DML tanpa izin.
