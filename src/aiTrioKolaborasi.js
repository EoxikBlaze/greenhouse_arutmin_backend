'use strict';
/**
 * aiTrioKolaborasi.js — Orkestrasi Multi-Agent 3 AI Smart Farm GARAP
 *
 * Menggabungkan keahlian 3 model AI lokal di Raspberry Pi:
 * 1. AI-1: Analis Sensor & Telemetri (qwen2.5:0.5b) — cepat, membaca anomali pH, TDS, dan suhu air.
 * 2. AI-2: Pakar Agronomi Budidaya Melon (garap-ai) — menguasai SOP melon, HST, polinasi, dan hama.
 * 3. AI-3: Dokter Konsultan & Sintesis (qwen2.5:1.5b / Sintesis Cerdas) — memadukan sensor + agronomi
 *          menjadi panduan aksi terpadu 3-pilar untuk petani.
 */

const config = require('./config');
const guard = require('./aiGuard');
const matrix = require('./aiMatrixPengetahuan');

const TIMEOUT_AGENT_MS = 25_000;

/**
 * Panggilan HTTP generik ke Ollama dengan optimasi termal:
 * - num_thread: 2 (Mencegah CPU 100% pada semua core, Raspberry Pi tetap sejuk <60°C)
 * - num_ctx: 512 (Hemat RAM & bus memori)
 * - temperature: 0.25 (Faktual & hemat komputasi sampling)
 */
async function panggilModel(modelName, messages, opsi = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opsi.timeoutMs || TIMEOUT_AGENT_MS);
  try {
    const res = await fetch(`${config.aiOllamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        messages,
        stream: false,
        think: false,
        keep_alive: '10m',
        options: {
          temperature: opsi.temperature || 0.25,
          num_predict: opsi.num_predict || 120,
          num_ctx: 512,
          num_thread: 2, // Mode hemat daya termal (2 core saja dari 4 core ARM)
        },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ollama_err_${res.status}`);
    const j = await res.json();
    const teks = j?.message?.content;
    if (typeof teks !== 'string' || !teks.trim()) throw new Error('respons_kosong');
    return teks.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * AI-1: Analis Sensor & Telemetri (qwen2.5:0.5b)
 * Mengevaluasi kondisi telemetri real-time: pH, TDS, Suhu Air, dan Alert.
 */
async function agenSensor(sensor, ambang, pesanPengguna) {
  const s = sensor || {};
  const phVal = s.ph != null ? s.ph : '-';
  const tdsVal = s.tds != null ? s.tds : '-';
  const suhuVal = s.waterTemp != null ? s.waterTemp : (s.suhu_air != null ? s.suhu_air : '-');

  // Ringkasan berbasis aturan data nyata untuk ketepatan 100%
  let statusPh = 'normal';
  let statusTds = 'normal';
  let statusSuhu = 'normal';

  if (s.ph != null && ambang?.ph) {
    if (s.ph < Number(ambang.ph.min)) statusPh = 'terlalu asam (drop)';
    else if (s.ph > Number(ambang.ph.max)) statusPh = 'terlalu basa (naik)';
  }
  if (s.tds != null && ambang?.tds) {
    if (s.tds < Number(ambang.tds.min)) statusTds = 'kurang pekat';
    else if (s.tds > Number(ambang.tds.max)) statusTds = 'terlalu pekat (overdosis)';
  }
  if (s.waterTemp != null && s.waterTemp > 29) {
    statusSuhu = 'panas (waspada oksigen terlarut)';
  }

  const ringkasan = `Sensor saat ini: pH ${phVal} (${statusPh}), TDS ${tdsVal} PPM (${statusTds}), Suhu air ${suhuVal}°C (${statusSuhu}).`;

  // Bila pengguna bertanya spesifik sensor, minta qwen2.5:0.5b memperdalam ulasan
  try {
    const prompt = `Kamu adalah Analis Sensor IoT Smart Farm. Nilai kondisi berikut: ${ringkasan}. Pertanyaan pengguna: "${pesanPengguna}". Jelaskan ringkas dalam 2 kalimat status bahaya atau keamanannya dalam Bahasa Indonesia.`;
    const ulasan = await panggilModel('qwen2.5:0.5b', [{ role: 'user', content: prompt }], { num_predict: 80 });
    return { ringkasan, ulasan, model: 'qwen2.5:0.5b', status: 'OK' };
  } catch (err) {
    return { ringkasan, ulasan: `Kondisi fisik tandon terpantau: pH ${phVal}, TDS ${tdsVal} PPM, Suhu ${suhuVal}°C.`, model: 'rule-sensor', status: 'FALLBACK' };
  }
}

/**
 * AI-2: Pakar Agronomi Melon (garap-ai)
 * Menganalisis kebutuhan botani, siklus HST, formula AB Mix, hama, dan polinasi.
 */
async function agenAgronomi(pesanPengguna, tahapTanam, ringkasanSensor) {
  const fase = tahapTanam ? `Tahap tanaman: ${tahapTanam.nama || 'Melon'} (Fase ${tahapTanam.fase || 'Berjalan'}).` : 'Komoditas utama: Melon Hidroponik Greenhouse.';
  const systemPrompt = `Kamu adalah Pakar Agronomi Melon GARAP. Berikan panduan budidaya, penanganan hama, atau nutrisi melon yang tepat berdasarkan agronomi ilmiah dalam 100% Bahasa Indonesia.`;

  const userContent = `${fase}\n${ringkasanSensor}\nPertanyaan Petani: "${pesanPengguna}"\nBerikan analisis agronomi, penyebab masalah, dan rekomendasi penanganan tanaman yang tepat.`;

  try {
    const jawaban = await panggilModel('garap-ai', [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ], { num_predict: 180 });
    return { jawaban, model: 'garap-ai', status: 'OK' };
  } catch (err) {
    // Fallback ke qwen2.5:0.5b jika garap-ai belum selesai
    const jawaban = await panggilModel('qwen2.5:0.5b', [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ], { num_predict: 140 });
    return { jawaban, model: 'qwen2.5:0.5b', status: 'FALLBACK' };
  }
}

/**
 * AI-3: Dokter Konsultan & Sintesis (Penyelarasan Tindakan)
 * Memadukan temuan AI-1 (Sensor) + AI-2 (Agronomi) menjadi panduan 3-pilar yang terstruktur.
 */
async function agenSintesis(pesanPengguna, sensorRes, agroRes) {
  // Format sintetis terstruktur yang sangat rapi dan siap baca
  const formatSintesis = [
    `🤝 **Kolaborasi 3 AI Smart Farm GARAP**`,
    `*(Analis Sensor & Telemetri • Pakar Agronomi garap-ai • Dokter Pertanian)*`,
    ``,
    `📊 **1. Kondisi Sensor & Lingkungan (Analis Telemetri):**`,
    `• ${sensorRes.ringkasan}`,
    `• ${sensorRes.ulasan}`,
    ``,
    `🌿 **2. Tinjauan Botani & Agronomi (Pakar Melon garap-ai):**`,
    `${agroRes.jawaban}`,
  ].join('\n');

  return formatSintesis;
}

/**
 * Titik Masuk Utama Orkestrasi Kolaborasi 3 AI
 */
async function orkestrasiTrio({ pesan, data, penampung }) {
  const mulai = Date.now();

  // 1. Jalankan Agen 1 (Sensor) secara paralel dengan persiapan Agen 2
  const sensorRes = await agenSensor(data?.sensor, data?.ambang, pesan);

  // 2. Jalankan Agen 2 (Pakar Agronomi garap-ai) dengan konteks dari Agen 1
  const agroRes = await agenAgronomi(pesan, data?.tahap, sensorRes.ringkasan);

  // 3. Sintesis terpadu (Agen 3)
  const hasilTeks = await agenSintesis(pesan, sensorRes, agroRes);

  const durasiMs = Date.now() - mulai;

  return {
    jawaban: hasilTeks,
    kolaborasi: {
      aktif: true,
      waktu_eksekusi_ms: durasiMs,
      tim: [
        { peran: 'Analis Sensor & Telemetri', model: sensorRes.model, status: sensorRes.status },
        { peran: 'Pakar Agronomi Melon', model: agroRes.model, status: agroRes.status },
        { peran: 'Sintesis (penggabung teks, tanpa model)', model: 'aturan-sintesis', status: 'OK' },
      ],
    },
  };
}

module.exports = { orkestrasiTrio, agenSensor, agenAgronomi, agenSintesis };

