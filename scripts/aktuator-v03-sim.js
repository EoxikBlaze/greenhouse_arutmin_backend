'use strict';
/**
 * MODEL PERILAKU firmware aktuator v0.3 (Fase 3B.3) — spesifikasi yang bisa diuji, BUKAN firmware.
 * Firmware ESP32 v0.3 belum ditulis; tes model ini tidak membuktikan perangkat aman.
 *
 * Aturan (docs/FASE3B2_GERBANG_3C.md §7):
 *  1. jam dari detak server (ts epoch); belum sinkron → perintah berisiko ditolak
 *  2. exp wajib; lewat → kedaluwarsa; terlalu jauh (> 600 dtk) → exp_tidak_wajar
 *  3. id_terakhir di NVS ditulis SEBELUM output nyala; id ≤ id_terakhir → duplikat (pompa tidak nyala)
 *  4. detak server hilang > 30 dtk / putus → output mati, tidak ada perintah baru
 *  5. E-STOP → output mati; perintah berisiko ditolak; STOP/STOP_DARURAT selalu diterima
 *  6. kalibrasi pompa (mL/dtk) & batas lokal dari NVS; hilang → belum_dikalibrasi / konfigurasi_tidak_lengkap
 *  7. DOSIS wajib kejadian & percobaan (identitas persetujuan)
 *  8. laporan: ml_nyata + durasi_ms + sumber_volume 'estimasi'; reboot saat jalan → laporan volume TIDAK DIKETAHUI
 *  9. laporan diulang sampai ack; pengulangan tidak menjalankan ulang pompa
 */
const FAILSAFE_MS = 30000;
const EXP_MAKS_DETIK = 600;
const BERISIKO = new Set(['DOSIS', 'BILAS', 'SAMPLING', 'ISI_AIR']);

class AktuatorV03 {
  /** @param {{nvs?: object}} o nvs = penyimpanan persisten (bertahan saat reboot) */
  constructor({ nvs = {} } = {}) {
    this.nvs = nvs; // {idTerakhir, kalibrasi:{AB:mlPerDetik,...}, batasMl:{AB:..}, sedangJalan:{id,mulaiMs,out}|null}
    this.reboot(0);
  }

  /** Daya mati/hidup: RAM hilang, NVS tetap. Perintah yang sedang jalan → laporan volume tidak diketahui. */
  reboot(nowMs) {
    this.offset = null; this.detakMs = null; this.estop = false; this.terhubung = true;
    this.kerja = null; this.output = false; this.laporan = [];
    if (this.nvs.sedangJalan) {
      this.laporan.push({ id: this.nvs.sedangJalan.id, status: 'gagal', hasil: { alasan: 'reboot_saat_jalan', ml_nyata: null, sumber_volume: 'tidak_diketahui' } });
      this.nvs.sedangJalan = null;
    }
    this.nowMs = nowMs;
  }

  epoch() { return this.offset == null ? null : (this.nowMs / 1000) + this.offset; }
  serverSegar() { return this.terhubung && this.detakMs != null && this.nowMs - this.detakMs < FAILSAFE_MS; }

  detak({ ts, estop = false, online = true }, nowMs) {
    this.nowMs = nowMs;
    if (!online) { this.berhenti('server_offline'); return; }
    this.offset = ts - nowMs / 1000;
    this.detakMs = nowMs;
    if (estop) { this.estop = true; this.berhenti('estop_server'); }
  }

  putus(nowMs) { this.nowMs = nowMs; this.terhubung = false; this.berhenti('server_hilang'); }
  sambung(nowMs) { this.nowMs = nowMs; this.terhubung = true; }

  tick(nowMs) {
    this.nowMs = nowMs;
    if (this.kerja && !this.serverSegar()) this.berhenti('server_hilang');
    if (this.kerja && nowMs - this.kerja.mulaiMs >= this.kerja.durasiMs) this.berhenti(null);
  }

  /** @returns {{diterima:boolean, alasan:string|null}} */
  terima(p, nowMs) {
    this.nowMs = nowMs;
    const tolak = (alasan) => { this.laporan.push({ id: p.id, status: 'gagal', hasil: { alasan, ml_nyata: 0, sumber_volume: 'tidak_jalan' } }); return { diterima: false, alasan }; };
    if (p.tipe === 'STOP_DARURAT') { this.estop = true; this.berhenti('stop_darurat'); return { diterima: true, alasan: null }; }
    if (p.tipe === 'STOP') { this.berhenti('dihentikan'); return { diterima: true, alasan: null }; }
    if (!BERISIKO.has(p.tipe)) return tolak('tipe_tidak_dikenal');
    if (!Number.isInteger(p.id) || p.id < 1) return tolak('id_tidak_sah');
    if (this.nvs.idTerakhir != null && p.id <= this.nvs.idTerakhir) return { diterima: false, alasan: 'duplikat' }; // tanpa efek
    if (this.estop) return tolak('estop');
    if (!this.serverSegar()) return tolak('server_hilang');
    const now = this.epoch();
    if (now == null) return tolak('jam_belum_sinkron');
    if (!Number.isFinite(p.exp)) return tolak('exp_tidak_ada');
    if (now > p.exp) return tolak('kedaluwarsa');
    if (p.exp - now > EXP_MAKS_DETIK) return tolak('exp_tidak_wajar');
    if (this.kerja) return tolak('sibuk');
    let out; let durasiMs;
    if (p.tipe === 'DOSIS') {
      if (!Number.isInteger(p.kejadian) || !Number.isInteger(p.percobaan)) return tolak('tanpa_persetujuan');
      out = p.parameter?.larutan;
      const laju = this.nvs.kalibrasi?.[out];
      const batas = this.nvs.batasMl?.[out];
      if (!(laju > 0)) return tolak('belum_dikalibrasi');
      if (!(batas > 0)) return tolak('konfigurasi_tidak_lengkap');
      const ml = p.parameter?.ml;
      if (!(ml > 0) || ml > batas) return tolak('ml_tidak_sah');
      durasiMs = Math.round((ml / laju) * 1000);
    } else {
      return tolak('belum_didukung_model'); // BILAS/SAMPLING/ISI_AIR: aturan sama, belum dimodelkan
    }
    // NVS dulu, baru output: reboot setelah ini tidak bisa menjalankan id yang sama lagi
    this.nvs.idTerakhir = p.id;
    this.nvs.sedangJalan = { id: p.id, mulaiMs: nowMs, out };
    this.kerja = { id: p.id, out, mulaiMs: nowMs, durasiMs, laju: this.nvs.kalibrasi[out] };
    this.output = true;
    return { diterima: true, alasan: null };
  }

  berhenti(alasan) {
    if (!this.kerja) { this.output = false; return; }
    const durasi = this.nowMs - this.kerja.mulaiMs;
    const ml = Math.round((this.kerja.laju * durasi) / 100) / 10;
    this.laporan.push({ id: this.kerja.id, status: alasan ? 'gagal' : 'selesai', hasil: { alasan: alasan || 'ok', ml_nyata: ml, durasi_ms: durasi, sumber_volume: 'estimasi' } });
    this.kerja = null; this.output = false; this.nvs.sedangJalan = null;
  }

  /** Laporan yang belum di-ack (dikirim ulang); ack menghapusnya. */
  kirimLaporan() { return this.terhubung ? [...this.laporan] : []; }
  ack(id) { this.laporan = this.laporan.filter((l) => l.id !== id); }
}

module.exports = { AktuatorV03, FAILSAFE_MS, EXP_MAKS_DETIK };
