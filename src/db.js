'use strict';
/** Pool PostgreSQL — satu-satunya koneksi ke DB yang sama dengan data existing. */
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 50,                 // headroom untuk ~1000 user bersamaan (query < 5ms)
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// Jangan biarkan error koneksi idle mematikan proses.
pool.on('error', () => {});

/** Jalankan query dengan parameter; kembalikan rows. */
async function q(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

/** Query satu baris (atau null). */
async function one(text, params) {
  const rows = await q(text, params);
  return rows[0] || null;
}

module.exports = { pool, q, one };
