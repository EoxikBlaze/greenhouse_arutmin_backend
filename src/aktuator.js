'use strict';
/**
 * Antrean perintah aktuator (server → ESP32 aktuator) dengan PAGAR KESELAMATAN di server.
 *
 * Prinsip: siapa pun yang meminta (pengguna, otomasi, AI) HANYA bisa mengantre perintah
 * yang lolos pagar di sini. AI/otomasi tidak pernah mengirim nilai mentah ke perangkat —
 * semua nilai divalidasi ulang terhadap `konfigurasi_dosis`, lock penampung, batas harian
 * dan latch E-STOP. Firmware ESP32 WAJIB punya batas sendiri juga (pertahanan berlapis).
 */
const { pool, q, one } = require('./db');
const { tidakTerisi } = require('./parameter');

/** Batas konfigurasi_dosis yang dipakai pagar per jenis perintah — wajib terisi & sah. */
const BATAS_WAJIB = {
  AB: ['maks_ml_per_suntikan', 'maks_volume_ab_hari_ml', 'maks_suntikan_per_kejadian', 'maks_kejadian_per_hari', 'peringatan_dini_kejadian'],
  PH: ['maks_ml_ph_per_suntikan', 'maks_volume_ph_hari_ml'],
  BILAS: ['maks_ml_bilas_per_perintah'],
};

const TIPE = ['DOSIS', 'BILAS', 'SAMPLING', 'ISI_AIR', 'STOP', 'STOP_DARURAT'];
const LARUTAN = ['AB', 'PH_UP', 'PH_DOWN'];
const PERANGKAT_AKTUATOR = 'aktuator-01';

class PerintahDitolak extends Error {
  constructor(status, pesan, errors) {
    super(pesan);
    this.status = status;
    this.errors = errors;
  }
}

/** Penolakan yang juga MENGUNCI penampung (Perancangan FINAL Aturan 9: alert 3 & 4 → LOCK). */
function tolakDanKunci(status, pesan, kunci) {
  const e = new PerintahDitolak(status, pesan);
  e.kunci = kunci; // { alasan, type, value } — diterapkan SETELAH rollback, agar tetap tersimpan
  return e;
}

/** Kejadian tanpa ronde baru selama ini dianggap selesai (mixing 15 mnt × 5 ronde masih jauh di bawahnya). */
const KEJADIAN_BASI_MENIT = 60;
const HARI_WITA = "(now() AT TIME ZONE 'Asia/Makassar')::date";

/**
 * LOCK penampung + alert kritis + tutup kejadian berjalan + batalkan dosis yang masih menunggu.
 * Dosing mati sampai admin membuka kunci; sensor, pencatatan, sirkulasi tetap jalan.
 * @returns {Promise<boolean>} false bila penampung sudah terkunci (alert tidak didobel)
 */
async function kunciPenampung(idMeja, { alasan, type, value }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO penampung_states (id_meja) VALUES ($1) ON CONFLICT (id_meja) DO NOTHING', [idMeja]);
    const baru = (await client.query(
      `UPDATE penampung_states SET status_lock = true, lock_alasan = $2, lock_sejak = now(), updated_at = now()
        WHERE id_meja = $1 AND NOT status_lock RETURNING id_meja`, [idMeja, String(alasan).slice(0, 100)])).rows[0];
    if (!baru) { await client.query('ROLLBACK'); return false; }
    const alert = (await client.query(
      `INSERT INTO alert_logs (type, value, id_meja, severity, locked, created_at, updated_at)
       VALUES ($1, $2, $3, 'critical', true, now(), now()) RETURNING id`,
      [type, String(value).slice(0, 100), idMeja])).rows[0];
    await client.query(
      `UPDATE dosing_events SET hasil = 'lock', lock_terpicu = true, id_alert = $2, selesai_pada = now(), updated_at = now()
        WHERE id_meja = $1 AND hasil = 'berjalan'`, [idMeja, alert.id]);
    await client.query(
      `UPDATE perintah_aktuator SET status = 'batal', selesai_pada = now()
        WHERE status = 'menunggu' AND tipe = 'DOSIS' AND (parameter->>'penampung')::bigint = $1`, [idMeja]);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Buka LOCK (admin, setelah memeriksa). Hitungan harian TIDAK direset (Perancangan: reset hanya 00:00). */
async function bukaKunci(idMeja, oleh) {
  const row = await one(
    `UPDATE penampung_states SET status_lock = false, lock_alasan = NULL, lock_sejak = NULL, updated_at = now()
      WHERE id_meja = $1 AND status_lock RETURNING id_meja`, [idMeja]);
  if (!row) return false;
  await q(
    `INSERT INTO alert_logs (type, value, id_meja, severity, locked, created_at, updated_at)
     VALUES ('reset', $1, $2, 'info', false, now(), now())`,
    [`LOCK dibuka oleh ${oleh || 'admin'}`.slice(0, 100), idMeja]);
  return true;
}

/** Peta konfigurasi_dosis → {param: number}. */
async function bacaKonfig(runner = q) {
  const rows = await runner('SELECT param, nilai FROM konfigurasi_dosis', []);
  const m = {};
  for (const r of rows.rows ?? rows) m[r.param] = Number(r.nilai);
  return m;
}

const angka = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const bulat1 = (n) => Math.round(n * 10) / 10;

/**
 * Validasi murni (tanpa DB). Mengembalikan parameter ter-normalisasi atau melempar 422.
 * @param {string} tipe
 * @param {object} p
 * @param {Record<string,number>} cfg konfigurasi_dosis
 */
function validasiPerintah(tipe, p, cfg) {
  if (!TIPE.includes(tipe)) throw new PerintahDitolak(422, 'Tipe perintah tidak dikenal.', { tipe: [`Pilih salah satu: ${TIPE.join(', ')}.`] });
  const body = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  const err = {};
  const out = {};
  const penampung = () => {
    const n = angka(body.penampung);
    if (!Number.isInteger(n) || n < 1 || n > 999999) err.penampung = ['penampung wajib berupa id meja (bilangan bulat ≥ 1).'];
    else out.penampung = n;
  };
  if (tipe === 'DOSIS') {
    penampung();
    if (!LARUTAN.includes(body.larutan)) err.larutan = [`larutan harus salah satu dari ${LARUTAN.join(', ')}.`];
    else out.larutan = body.larutan;
    const ml = angka(body.ml);
    if (!Number.isFinite(ml) || ml <= 0) err.ml = ['ml wajib angka > 0.'];
    else {
      const batas = body.larutan === 'AB'
        ? (cfg.maks_ml_per_suntikan ?? 214)
        : (cfg.maks_ml_ph_per_suntikan ?? 10);
      if (ml > batas) err.ml = [`ml melebihi batas per suntikan (${batas} mL).`];
      else out.ml = bulat1(ml);
    }
  } else if (tipe === 'BILAS') {
    penampung();
    const ml = angka(body.ml ?? 100);
    const batas = cfg.maks_ml_bilas_per_perintah ?? 500;
    if (!Number.isFinite(ml) || ml <= 0 || ml > batas) err.ml = [`ml bilas harus 1–${batas}.`];
    else out.ml = bulat1(ml);
  } else if (tipe === 'SAMPLING') {
    penampung();
  } else if (tipe === 'ISI_AIR') {
    penampung();
    const aksi = String(body.aksi || 'MULAI').toUpperCase();
    if (!['MULAI', 'STOP'].includes(aksi)) err.aksi = ['aksi harus MULAI atau STOP.'];
    else out.aksi = aksi;
    // nomor katup di perangkat (≠ id_meja server); dipakai firmware v0.3, opsional demi kontrak lama
    if (body.katup !== undefined) {
      const k = angka(body.katup);
      if (!Number.isInteger(k) || k < 1 || k > 64) err.katup = ['katup harus bilangan bulat 1–64.'];
      else out.katup = k;
    }
  }
  if (Object.keys(err).length) throw new PerintahDitolak(422, 'Data tidak valid.', err);
  return out;
}

/** Perintah yang menambah risiko (butuh pagar penuh & ditolak saat E-STOP). */
const berisiko = (tipe, param) => tipe === 'DOSIS' || tipe === 'BILAS' || tipe === 'SAMPLING'
  || (tipe === 'ISI_AIR' && param.aksi === 'MULAI');

/**
 * Antre perintah. Atomik (transaksi) — pagar, penghitung harian, dan INSERT satu kesatuan.
 * @returns {Promise<object>} baris perintah_aktuator
 */
async function buatPerintah({ tipe, parameter, sumber = 'pengguna', userId = null, alasan = null, ttlDetik = 120, perangkat = PERANGKAT_AKTUATOR, idempotencyKey = null }) {
  const ttl = Math.min(600, Math.max(10, Number(ttlDetik) || 120));
  const client = await pool.connect();
  let released = false;
  try {
    await client.query('BEGIN');
    const cfg = await bacaKonfig((t, pr) => client.query(t, pr));
    const wajib = tipe === 'DOSIS' ? BATAS_WAJIB[parameter?.larutan === 'AB' ? 'AB' : 'PH'] : tipe === 'BILAS' ? BATAS_WAJIB.BILAS : [];
    if (wajib.length) {
      const kosong = await tidakTerisi({ konfigurasi_dosis: wajib }, (t, pr) => client.query(t, pr));
      if (kosong.length) {
        throw new PerintahDitolak(409, `Batas keselamatan belum terisi/tidak sah: ${kosong.map((k) => `${k.param} (${k.status})`).join(', ')}. Perintah ditolak.`);
      }
    }
    const param = validasiPerintah(tipe, parameter, cfg);

    const dev = (await client.query('SELECT kode, peran FROM perangkat WHERE kode = $1', [perangkat])).rows[0];
    if (!dev || dev.peran !== 'aktuator') throw new PerintahDitolak(404, 'Perangkat aktuator tidak ditemukan.');

    const estop = (await client.query("SELECT nilai FROM aktuator_state WHERE kunci = 'estop' FOR UPDATE")).rows[0]?.nilai === '1';
    if (estop && berisiko(tipe, param)) {
      throw new PerintahDitolak(423, 'E-STOP aktif — semua perintah berisiko ditolak sampai di-reset oleh admin.');
    }

    if (berisiko(tipe, param)) {
      const antre = Number((await client.query(
        "SELECT count(*) FROM perintah_aktuator WHERE perangkat_kode = $1 AND status IN ('menunggu','dikirim')", [perangkat])).rows[0].count);
      if (antre >= 10) throw new PerintahDitolak(429, 'Antrean perintah penuh (maks 10). Tunggu perintah sebelumnya selesai.');
      const meja = (await client.query('SELECT 1 FROM mejas WHERE id_meja = $1', [param.penampung])).rows[0];
      if (!meja) throw new PerintahDitolak(404, 'Penampung (meja) tidak ditemukan.');
    }

    if (tipe === 'DOSIS') {
      // state penampung: buat bila belum ada, kunci baris, reset harian bila lewat tengah malam (WITA)
      await client.query('INSERT INTO penampung_states (id_meja) VALUES ($1) ON CONFLICT (id_meja) DO NOTHING', [param.penampung]);
      const st = (await client.query(
        `SELECT *, (reset_harian_pada IS NULL OR reset_harian_pada::date < (now() AT TIME ZONE 'Asia/Makassar')::date) AS perlu_reset
           FROM penampung_states WHERE id_meja = $1 FOR UPDATE`, [param.penampung])).rows[0];
      let { volume_ab_hari_ml: ab, volume_ph_hari_ml: ph, kejadian_dosis_hari: kej } = st;
      if (st.perlu_reset) { ab = 0; ph = 0; kej = 0; }
      ab = Number(ab); ph = Number(ph);
      if (st.status_lock) throw new PerintahDitolak(423, `Penampung terkunci${st.lock_alasan ? ` (${st.lock_alasan})` : ''} — dosis ditolak.`);
      if (st.mode_pemeliharaan && sumber !== 'pengguna') throw new PerintahDitolak(423, 'Penampung dalam mode pemeliharaan — dosis otomatis ditolak.');
      // volume harian = pagar utama. Otomasi yang mentok → LOCK + alert (alert 4); pengguna cukup ditolak
      // (boleh meminta takaran lebih kecil).
      const habis = (jenis, isi, batas) => {
        const pesan = `Batas volume ${jenis} harian tercapai (${isi}/${batas} mL).`;
        return sumber === 'pengguna' ? new PerintahDitolak(409, pesan)
          : tolakDanKunci(409, `${pesan} Penampung dikunci.`, { alasan: `Jatah volume ${jenis} harian habis`, type: 'batas_dosis', value: `${jenis} ${isi}/${batas} mL` });
      };
      if (param.larutan === 'AB') {
        const batas = cfg.maks_volume_ab_hari_ml ?? 500;
        if (ab + param.ml > batas) throw habis('AB', ab, batas);
        ab += param.ml;

        // B3 — KEJADIAN: 1 sesi perbaikan = sampai 5 suntikan; hanya kejadian BARU yang memotong jatah 8/hari.
        await client.query(
          `UPDATE dosing_events SET hasil = 'timeout', selesai_pada = now(), updated_at = now()
            WHERE id_meja = $1 AND hasil = 'berjalan'
              AND (hari < ${HARI_WITA} OR updated_at < now() - interval '${KEJADIAN_BASI_MENIT} minutes')`, [param.penampung]);
        let ev = (await client.query(
          "SELECT id, ronde_total FROM dosing_events WHERE id_meja = $1 AND hasil = 'berjalan' ORDER BY id DESC LIMIT 1 FOR UPDATE",
          [param.penampung])).rows[0];
        const maksSuntik = cfg.maks_suntikan_per_kejadian ?? 5;
        const maksKej = cfg.maks_kejadian_per_hari ?? 8;
        if (ev && ev.ronde_total >= maksSuntik) {
          // B4 — retry habis (alert 3): target tak tercapai setelah 5 suntikan
          throw tolakDanKunci(423, `Retry habis: ${ev.ronde_total} suntikan dalam satu kejadian belum mencapai target. Penampung dikunci — periksa sebelum membuka kunci.`,
            { alasan: `Retry EC habis (${ev.ronde_total}x)`, type: 'retry_habis', value: `${ev.ronde_total}/${maksSuntik} suntikan` });
        }
        if (!ev) {
          if (kej >= maksKej) {
            // B4 — jatah kejadian harian habis (alert 4)
            throw tolakDanKunci(409, `Jatah ${maksKej} kejadian dosing hari ini habis. Penampung dikunci sampai diperiksa.`,
              { alasan: `Jatah ${maksKej} kejadian/hari habis`, type: 'batas_dosis', value: `${kej}/${maksKej} kejadian` });
          }
          const manual = sumber === 'pengguna' && userId != null;
          ev = (await client.query(
            `INSERT INTO dosing_events (id_meja, hari, pemicu, aktor_tipe, dipicu_oleh, alasan)
             VALUES ($1, ${HARI_WITA}, $2, $3, $4, $5) RETURNING id, ronde_total`,
            [param.penampung, manual ? 'USER_MANUAL' : sumber === 'otomasi' ? 'SISTEM' : 'API',
              manual ? 'user' : 'system', manual ? userId : null, alasan ? String(alasan).slice(0, 200) : null])).rows[0];
          kej += 1;
          const dini = cfg.peringatan_dini_kejadian ?? 3;
          if (kej === dini) {
            // PERINGATAN DINI (belum LOCK): cek talang bocor, sensor, atau kebutuhan tanaman
            await client.query(
              `INSERT INTO alert_logs (type, value, id_meja, severity, locked, created_at, updated_at)
               VALUES ('batas_dosis', $1, $2, 'info', false, now(), now())`,
              [`${kej} kejadian dosing hari ini — cek talang, sensor, kebutuhan tanaman`, param.penampung]);
          }
        }
        await client.query(
          'UPDATE dosing_events SET ronde_total = ronde_total + 1, volume_total_ml = volume_total_ml + $2, updated_at = now() WHERE id = $1',
          [ev.id, param.ml]);
      } else {
        const batas = cfg.maks_volume_ph_hari_ml ?? 100;
        if (ph + param.ml > batas) throw habis('pH', ph, batas);
        ph += param.ml;
      }
      await client.query(
        `UPDATE penampung_states SET volume_ab_hari_ml = $2, volume_ph_hari_ml = $3, kejadian_dosis_hari = $4,
                reset_harian_pada = now(), updated_at = now() WHERE id_meja = $1`,
        [param.penampung, ab, ph, kej]);
    }

    if (tipe === 'STOP_DARURAT') {
      await client.query("UPDATE aktuator_state SET nilai = '1', diubah_pada = now() WHERE kunci = 'estop'");
      await client.query(
        "UPDATE perintah_aktuator SET status = 'batal', selesai_pada = now() WHERE perangkat_kode = $1 AND status = 'menunggu'", [perangkat]);
    }

    const row = (await client.query(
      `INSERT INTO perintah_aktuator (perangkat_kode, tipe, parameter, sumber, dibuat_oleh, alasan, kedaluwarsa_pada, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval, $8)
       RETURNING id, perangkat_kode, tipe, parameter, status, sumber, alasan, kedaluwarsa_pada, dibuat_pada`,
      [perangkat, tipe, param, sumber, userId, alasan ? String(alasan).slice(0, 200) : null, String(ttl), idempotencyKey])).rows[0];
    await client.query('COMMIT');
    return row;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.kunci) {
      client.release();
      released = true;
      // lock dicatat terpisah dari transaksi perintah yang dibatalkan; galatnya tidak boleh menutupi penolakan
      await kunciPenampung(Number(parameter.penampung), e.kunci)
        .catch((err) => console.error('[aktuator] gagal mengunci penampung:', err.message));
    }
    throw e;
  } finally {
    if (!released) client.release();
  }
}

/**
 * Bersihkan antrean: menunggu kedaluwarsa → 'kedaluwarsa'; dikirim >90 dtk tanpa hasil → 'gagal'.
 * DOSIS yang timeout: volume tidak diketahui → jatah tidak dikembalikan + penampung dikunci.
 */
async function rapikanAntrean(perangkat) {
  await q(
    `UPDATE perintah_aktuator SET status = 'kedaluwarsa', selesai_pada = now()
      WHERE perangkat_kode = $1 AND status = 'menunggu' AND kedaluwarsa_pada <= now()`, [perangkat]);
  const timeout = await q(
    `UPDATE perintah_aktuator SET status = 'gagal', selesai_pada = now(), hasil = '{"error":"timeout_tanpa_laporan"}'
      WHERE perangkat_kode = $1 AND status = 'dikirim' AND dikirim_pada <= now() - interval '90 seconds'
      RETURNING id, tipe, parameter`, [perangkat]);
  for (const p of timeout.filter((x) => x.tipe === 'DOSIS')) {
    await kunciPenampung(Number(p.parameter.penampung), {
      alasan: 'Dosis tanpa laporan hasil (timeout)', type: 'volume_tidak_pasti', value: `perintah ${p.id}: ${p.parameter.larutan} ${p.parameter.ml} mL`,
    }).catch((e) => console.error('[aktuator] gagal mengunci penampung setelah timeout:', e.message));
  }
}

/** Ambil perintah menunggu untuk perangkat (atomik, tiap perintah hanya terkirim sekali). */
async function ambilPerintah(perangkat, maks = 5) {
  await rapikanAntrean(perangkat);
  const rows = await q(
    `UPDATE perintah_aktuator SET status = 'dikirim', dikirim_pada = now()
      WHERE id IN (
        SELECT id FROM perintah_aktuator
         WHERE perangkat_kode = $1 AND status = 'menunggu' AND kedaluwarsa_pada > now()
         ORDER BY (tipe = 'STOP_DARURAT') DESC, (tipe = 'STOP') DESC, id
         LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING id, tipe, parameter, kedaluwarsa_pada`,
    [perangkat, Math.min(10, Math.max(1, Number(maks) || 5))]);
  return rows.sort((a, b) => Number(a.id) - Number(b.id));
}

/** Laporan hasil dari perangkat. Hanya perintah miliknya & berstatus 'dikirim'. */
/**
 * Kategori volume dosis (Fase 3B.4) — empat hal yang TIDAK boleh disamakan:
 *   DIPERINTAHKAN (parameter.ml) · ESTIMASI (ml_nyata dari waktu × laju firmware, belum terkalibrasi) ·
 *   UKUR (sumber_volume 'ukur', mis. flow meter) · TIDAK_DIKETAHUI (ml_nyata tidak ada/tidak sah) ·
 *   TIDAK_JALAN (ml_nyata = 0 tepat: perintah ditolak/dihentikan sebelum output nyala).
 */
function kategoriVolume(hasil, mlDiperintahkan) {
  const nyata = hasil?.ml_nyata;
  if (!(typeof nyata === 'number' && Number.isFinite(nyata) && nyata >= 0)) return { kategori: 'TIDAK_DIKETAHUI', ml: null, diperintahkan: mlDiperintahkan };
  if (nyata === 0) return { kategori: 'TIDAK_JALAN', ml: 0, diperintahkan: mlDiperintahkan };
  return { kategori: hasil.sumber_volume === 'ukur' ? 'UKUR' : 'ESTIMASI', ml: Math.min(nyata, mlDiperintahkan), diperintahkan: mlDiperintahkan };
}

async function laporHasil(perangkat, id, { status, hasil }) {
  if (!['selesai', 'gagal'].includes(status)) throw new PerintahDitolak(422, 'Data tidak valid.', { status: ['status harus selesai atau gagal.'] });
  const aman = hasil && typeof hasil === 'object' && !Array.isArray(hasil) && JSON.stringify(hasil).length <= 2000 ? hasil : null;
  const row = await one(
    `UPDATE perintah_aktuator SET status = $3, selesai_pada = now(), hasil = $4
      WHERE id = $1 AND perangkat_kode = $2 AND status = 'dikirim'
      RETURNING id, tipe, parameter, status, hasil`,
    [id, perangkat, status, aman]);
  if (!row) throw new PerintahDitolak(404, 'Perintah tidak ditemukan atau sudah dilaporkan.');
  // Dosis GAGAL: jatah harian dikembalikan HANYA bila terbukti tidak/kurang keluar — TIDAK_JALAN (penuh) atau UKUR
  // (sisa terukur). ESTIMASI (waktu × laju contoh firmware) dianggap keluar seluruhnya. TIDAK_DIKETAHUI → tanpa
  // pengembalian + penampung dikunci (cegah dosis ulang yang bisa overdosis) sampai admin memeriksa.
  if (row.tipe === 'DOSIS') {
    const vol = kategoriVolume(aman, Number(row.parameter.ml));
    await q("UPDATE perintah_aktuator SET hasil = coalesce(hasil, '{}'::jsonb) || jsonb_build_object('volume_server', $2::jsonb) WHERE id = $1", [row.id, vol]);
    row.hasil = { ...(row.hasil || {}), volume_server: vol };
  }
  if (status === 'gagal' && row.tipe === 'DOSIS') {
    const { penampung, larutan } = row.parameter;
    const vol = row.hasil.volume_server;
    if (vol.kategori === 'TIDAK_DIKETAHUI') {
      await kunciPenampung(Number(penampung), {
        alasan: 'Volume dosis gagal tidak diketahui', type: 'volume_tidak_pasti', value: `perintah ${row.id}: ${larutan} ${row.parameter.ml} mL, ml_nyata tidak dilaporkan`,
      });
      return row;
    }
    // ESTIMASI (waktu × laju contoh) bukan bukti: dianggap keluar seluruhnya → tidak ada pengembalian (aman dari overdosis)
    if (vol.kategori === 'ESTIMASI') return row;
    const keluar = vol.ml;
    const ml = Math.round((Number(row.parameter.ml) - keluar) * 10) / 10;
    const kol = larutan === 'AB' ? 'volume_ab_hari_ml' : 'volume_ph_hari_ml';
    await q(`UPDATE penampung_states SET ${kol} = GREATEST(0, ${kol} - $2), updated_at = now() WHERE id_meja = $1`, [penampung, ml]);
    if (larutan === 'AB') {
      // suntikan yang tidak mengeluarkan apa pun bukan ronde; kejadian yang jadi kosong tidak memotong jatah harian.
      // Suntikan yang sebagian keluar TETAP dihitung ronde — hanya volumenya dikoreksi.
      const ev = await one(
        `UPDATE dosing_events SET ronde_total = GREATEST(0, ronde_total - $3), volume_total_ml = GREATEST(0, volume_total_ml - $2), updated_at = now()
          WHERE id = (SELECT id FROM dosing_events WHERE id_meja = $1 AND hasil = 'berjalan' ORDER BY id DESC LIMIT 1)
          RETURNING id, ronde_total`, [penampung, ml, keluar > 0 ? 0 : 1]);
      if (ev && ev.ronde_total === 0) {
        await q('DELETE FROM dosing_events WHERE id = $1', [ev.id]);
        await q('UPDATE penampung_states SET kejadian_dosis_hari = GREATEST(0, kejadian_dosis_hari - 1), updated_at = now() WHERE id_meja = $1', [penampung]);
      }
    }
  }
  return row;
}

async function resetEstop() {
  await q("UPDATE aktuator_state SET nilai = '0', diubah_pada = now() WHERE kunci = 'estop'");
}
async function statusEstop() {
  return (await one("SELECT nilai, diubah_pada FROM aktuator_state WHERE kunci = 'estop'")) || { nilai: '0' };
}

module.exports = {
  TIPE, LARUTAN, PERANGKAT_AKTUATOR, PerintahDitolak,
  bacaKonfig, validasiPerintah, buatPerintah, ambilPerintah, laporHasil, kategoriVolume, rapikanAntrean, resetEstop, statusEstop,
  kunciPenampung, bukaKunci, KEJADIAN_BASI_MENIT,
};
