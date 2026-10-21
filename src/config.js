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
  /* Asisten AI lokal (Ollama) — dipakai src/routes/ai.js.
   * Default aman: model ringan 1,5B & Ollama di mesin yang sama (lihat docs/AI_LOKAL_PI.md). */
  aiModel: process.env.AI_MODEL || 'qwen2.5:1.5b',
  aiOllamaUrl: String(process.env.AI_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
};
