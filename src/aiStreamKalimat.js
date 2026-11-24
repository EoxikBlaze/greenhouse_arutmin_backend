'use strict';
/**
 * Streaming jawaban LLM PER KALIMAT (bukan per token).
 *
 * Guard keluaran lengkap (bahasa Inggris, luar topik, basa-basi) hanya bisa menilai
 * jawaban utuh, jadi klien selalu MENGGANTI teks yang dialirkan dengan jawaban akhir.
 * Di sini tiap kalimat hanya diteruskan bila lolos cek yang bisa dilakukan per kalimat:
 * kebocoran prompt/kode internal (dinilai pada seluruh teks sejauh ini) dan kode program.
 * Begitu satu kalimat gagal, aliran berhenti — sisa jawaban hanya lewat jalur akhir.
 */
const guard = require('./aiGuard');

const BATAS_KALIMAT = /^[\s\S]*?(?:[.!?…](?=\s)|\n)/;

/** Penampung teks: tambah(potongan) → kalimat yang sudah utuh; sisa() → ekor yang belum berakhir. */
function buatPemecah() {
  let buf = '';
  return {
    tambah(potongan) {
      buf += potongan;
      const siap = [];
      for (let m = buf.match(BATAS_KALIMAT); m; m = buf.match(BATAS_KALIMAT)) {
        buf = buf.slice(m[0].length);
        const k = m[0].trim();
        if (k) siap.push(k);
      }
      return siap;
    },
    sisa() { return buf.trim(); },
  };
}

const AKHIR_KALIMAT = /[.!?…][)"'”]*$/;

/**
 * Buang ekor kalimat yang terpotong batas token (num_predict). Uji 15 Nov 2026:
 * model 1,5B tidak patuh "maks 2 kalimat", jadi jawaban bisa berhenti di "…Anda bisa".
 * Teks tanpa satu pun akhir kalimat, atau yang diakhiri baris tabel, dibiarkan.
 */
function potongKeKalimatUtuh(teks) {
  const t = String(teks || '').trimEnd();
  const barisAkhir = t.split('\n').pop().trim();
  if (AKHIR_KALIMAT.test(t) || barisAkhir.startsWith('|')) return t;
  let akhir = -1;
  for (const m of t.matchAll(/[.!?…](?=\s)/g)) akhir = m.index + 1;
  return akhir > 0 ? t.slice(0, akhir) : t;
}

/** Baca body NDJSON Ollama (stream:true) → potongan teks message.content. */
async function* potonganOllama(body) {
  const dekoder = new TextDecoder();
  let sisa = '';
  for await (const chunk of body) {
    sisa += dekoder.decode(chunk, { stream: true });
    const baris = sisa.split('\n');
    sisa = baris.pop();
    for (const b of baris) {
      if (!b.trim()) continue;
      const j = JSON.parse(b);
      if (j.error) throw new Error(`ollama_${j.error}`);
      if (j.message && j.message.content) yield j.message.content;
    }
  }
}

/**
 * Teruskan kalimat yang lolos cek ke onKalimat; kembalikan teks lengkap untuk guard akhir.
 * @param {AsyncIterable<string>} potongan
 * @param {(kalimat: string) => void} onKalimat
 */
async function alirkanKalimat(potongan, onKalimat) {
  const pemecah = buatPemecah();
  let penuh = '';
  let berhenti = false;
  const teruskan = (kalimat) => {
    if (berhenti) return;
    if (guard.saringKeluaran(penuh, 6000).bocor || guard.adaKode(kalimat)) { berhenti = true; return; }
    if (kalimat.startsWith('|')) return; // baris tabel markdown → dikirim terstruktur di jawaban akhir
    const bersih = guard.saringKeluaran(kalimat).teks;
    if (bersih) onKalimat(bersih);
  };
  for await (const p of potongan) {
    penuh += p;
    pemecah.tambah(p).forEach(teruskan);
  }
  const ekor = pemecah.sisa();
  if (ekor && AKHIR_KALIMAT.test(ekor)) teruskan(ekor); // ekor terpotong batas token tidak dipratinjau
  return penuh;
}

module.exports = { buatPemecah, potonganOllama, alirkanKalimat, potongKeKalimatUtuh };
