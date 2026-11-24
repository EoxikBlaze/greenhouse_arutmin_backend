'use strict';
/**
 * Konfigurasi — membaca .env sederhana (tanpa dependensi).
 * Semua rahasia hanya hidup di .env, tidak pernah dikirim ke client.
 */
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

module.exports = {
  port: Number(process.env.PORT || 8000),
  host: process.env.HOST || '127.0.0.1',
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-ganti',
  appKey: process.env.APP_KEY || '',
  esp32ApiKey: process.env.ESP32_API_KEY || 'HARVEST123',
  https: process.env.HTTPS === '1',
  /* Asisten AI — default Cloud AI Gratis tanpa API key (Pollinations OpenAI-compatible)
   * sehingga hemat 100% RAM/CPU di Raspberry Pi; tetap mendukung URL Ollama lokal untuk pengujian. */
  aiModel: process.env.AI_MODEL || 'openai',
  aiOllamaUrl: String(process.env.AI_OLLAMA_URL || 'https://text.pollinations.ai/openai').replace(/\/+$/, ''),
  aiApiKey: process.env.AI_API_KEY || '',
  /* Broker MQTT lokal untuk 2 ESP32 (src/mqttJembatan.js). Kosong = jembatan MQTT mati, HTTP tetap jalan. */
  /* Uji pompa dari aplikasi (kalibrasi laju). Bawaan MATI: pompa sungguhan menyala. Nyalakan sadar di .env: UJI_POMPA_DIIZINKAN=1. */
  ujiPompaDiizinkan: process.env.UJI_POMPA_DIIZINKAN === '1',
  mqttUrl: process.env.MQTT_URL || '',
  mqttUser: process.env.MQTT_USER || '',
  mqttPass: process.env.MQTT_PASS || '',
};
