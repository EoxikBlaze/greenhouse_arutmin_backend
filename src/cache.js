'use strict';
/**
 * Cache TTL in-memory — O(1) get/set, ukuran dibatasi, auto-prune.
 * Untuk data yang jarang berubah (ambang sensor) dan polling (latest sensor)
 * supaya beban DB turun drastis di 1000 user bersamaan.
 */
const store = new Map(); // key -> { value, expiresAt }

function get(key) {
  const e = store.get(key);
  if (!e) return undefined;
  if (e.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return e.value;
}

function set(key, value, ttlMs) {
  if (store.size > 5000) {
    const now = Date.now();
    for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
    if (store.size > 5000) store.clear();
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Ambil dari cache; kalau kosong, jalankan fn lalu simpan. */
async function remember(key, ttlMs, fn) {
  const hit = get(key);
  if (hit !== undefined) return hit;
  const value = await fn();
  set(key, value, ttlMs);
  return value;
}

module.exports = { get, set, remember };
