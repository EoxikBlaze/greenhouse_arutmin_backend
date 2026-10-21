'use strict';
/**
 * Integripsi — AUDIT TRAIL (tabel audit_logs + GET /audit-logs).
 * Kontrak: docs/openapi.yaml#/paths/~1audit-logs · src/audit.js · src/routes/audit.js.
 * Server sendiri (PORT bebas) — lihat _server.js; src/ tidak disentuh.
 *
 * Pencatatan berjalan ASINKRON di handler `finish` (src/audit.js), jadi tes
 * memakai polling tungguMuncul() — bukan asersi langsung satu tembakan.
 * IDEMPOTEN: baris uji memakai prefix 'itest-audit-' + suffix acak dan dihapus
 * di after(); jejak yang tertinggal HANYA baris log audit (memang append-only).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, adminToken, craftToken, bearer, readEnv } = require('./_server');

let srv;
let base;
let auth;
const env = readEnv();

const tokenPetani = () => craftToken(
  { sub: 3, username: 'petani', level: 'petani', demo: false }, { expiresIn: '1h' });
const tokenDemo = () => craftToken(
  { sub: 2, username: 'demo', level: 'user', demo: true }, { expiresIn: '1h' });

let mejaId = null;        // baris uji /meja (dibuat → diubah → dihapus)
let userId = null;        // baris uji /user
const namaMeja = `itest-audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const namaUser = `itestaudit${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET /audit-logs dgn filter → respons supertest. */
function ambil(params = {}) {
  return request(base).get('/audit-logs').set(auth).query(params);
}

/**
 * Polling entri audit (perekam berjalan setelah balasan terkirim).
 * @param {(rows: object[]) => boolean} predikat
 * @returns {Promise<object[]>} baris terakhir yang dibaca saat predikat terpenuhi
 */
async function tungguMuncul(predikat, { timeout = 5000, interval = 100 } = {}) {
  const batas = Date.now() + timeout;
  let terakhir = [];
  for (;;) {
    const res = await ambil({ per_page: 100 });
    assert.equal(res.status, 200, `GET /audit-logs gagal: ${res.text}`);
    terakhir = res.body.data || [];
    if (predikat(terakhir)) return terakhir;
    if (Date.now() > batas) {
      assert.fail(`entri audit yang dicari tidak muncul dalam ${timeout}ms`
        + ` (contoh aksi: ${terakhir.slice(0, 8).map((r) => `${r.aksi}/${r.tabel}`).join(', ')})`);
    }
    await delay(interval);
  }
}

before(async () => {
  srv = await startServer();
  base = srv.base;
  auth = bearer(await adminToken(base));
});

after(async () => {
  if (!srv) return;
  // Jaring pengaman: baris uji dibersihkan bila tes gagal di tengah jalan.
  if (mejaId) await request(base).delete(`/meja/${mejaId}`).set(auth);
  if (userId) await request(base).delete(`/user/${userId}`).set(auth);
  await srv.stop();
});

test('GET /audit-logs tanpa token → 401 kontrak', async () => {
  const res = await request(base).get('/audit-logs');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { message: 'Tidak terautentikasi.' });
});

test('GET /audit-logs (token petani) → 403 PetaniGuard', async () => {
  const res = await request(base).get('/audit-logs').set(bearer(tokenPetani()));
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, {
    message: 'Menu ini untuk pengelola. Silakan gunakan menu "Tanam Saya".',
  });
});

test('GET /audit-logs (token demo) → 200 (baca lolos, sama dgn admin)', async () => {
  const res = await request(base).get('/audit-logs').set(bearer(tokenDemo()));
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.total, 'number');
  assert.ok(Array.isArray(res.body.data));
});

test('POST /meja sukses → entri CREATE tercatat (aktor, tabel, row_id, after)', async () => {
  const buat = await request(base).post('/meja').set(auth)
    .send({ meja: namaMeja, jumlah_lubang: 7 });
  assert.equal(buat.status, 201, `body: ${buat.text}`);
  mejaId = buat.body.data.id_meja;

  const baris = await tungguMuncul((rows) => rows.some(
    (r) => r.aksi === 'create' && r.tabel === 'mejas' && String(r.row_id) === String(mejaId),
  ));
  const entri = baris.find(
    (r) => r.aksi === 'create' && r.tabel === 'mejas' && String(r.row_id) === String(mejaId),
  );
  assert.ok(entri, 'baris audit CREATE /meja wajib ada');
  assert.equal(entri.actor_label, 'garap', 'actor_label diisi dari username');
  assert.equal(entri.actor_tipe, 'user', 'CHECK enum actor_tipe: akun nyata = user');
  assert.equal(entri.meta.level, 'admin', 'peran disimpan di meta.level (kolom actor_tipe terbatas)');
  assert.ok(Number.isSafeInteger(Number(entri.actor_user_id)));
  assert.equal(entri.before_data, null, 'CREATE tanpa before_data');
  assert.equal(entri.after_data.meja, namaMeja);
  assert.ok(entri.ip, 'ip klien ikut tercatat');
  assert.ok(entri.terjadi_pada, 'terjadi_pada terisi');
  assert.match(String(entri.meta.rute), /^POST \/meja$/);
});

test('PUT lalu DELETE /meja → entri UPDATE (before/after) & DELETE (before)', async () => {
  const ubah = await request(base).put(`/meja/${mejaId}`).set(auth)
    .send({ jumlah_lubang: 11 });
  assert.equal(ubah.status, 200, `body: ${ubah.text}`);

  await tungguMuncul((rows) => rows.some(
    (r) => r.aksi === 'update' && r.tabel === 'mejas' && String(r.row_id) === String(mejaId),
  ));
  const semua = await ambil({ per_page: 100 });
  const update = semua.body.data.find(
    (r) => r.aksi === 'update' && r.tabel === 'mejas' && String(r.row_id) === String(mejaId),
  );
  assert.ok(update, 'baris audit UPDATE /meja wajib ada');
  assert.equal(update.before_data.jumlah_lubang, 7, 'before_data = nilai lama');
  assert.equal(update.after_data.jumlah_lubang, 11, 'after_data = nilai baru');
  assert.equal(update.after_data.meja, namaMeja, 'baris penuh ikut terekam (ringkas)');

  const hapus = await request(base).delete(`/meja/${mejaId}`).set(auth);
  assert.equal(hapus.status, 200, `body: ${hapus.text}`);
  await tungguMuncul((rows) => rows.some(
    (r) => r.aksi === 'delete' && r.tabel === 'mejas' && String(r.row_id) === String(mejaId),
  ));
  const sesudah = await ambil({ per_page: 100 });
  const del = sesudah.body.data.find(
    (r) => r.aksi === 'delete' && r.tabel === 'mejas' && String(r.row_id) === String(mejaId),
  );
  assert.ok(del, 'baris audit DELETE /meja wajib ada');
  assert.equal(del.before_data.meja, namaMeja, 'DELETE menyimpan baris terakhir sbg before');
  assert.equal(del.after_data, null);

  // NET-ZERO: baris uji benar-benar hilang dari /meja.
  const cek = await request(base).get(`/meja/${mejaId}`).set(auth);
  assert.equal(cek.status, 404);
  mejaId = null;
});

test('POST /user sukses → entri CREATE users TANPA password (kebocoran rahasia dicek)', async () => {
  const buat = await request(base).post('/user').set(auth).send({
    username: namaUser,
    email: `${namaUser}@example.com`,
    password: 'kata-sandi-uji-123',
    level: 'user',
  });
  assert.equal(buat.status, 201, `body: ${buat.text}`);
  userId = buat.body.data.id;

  const baris = await tungguMuncul((rows) => rows.some(
    (r) => r.aksi === 'create' && r.tabel === 'users' && String(r.row_id) === String(userId),
  ));
  const entri = baris.find(
    (r) => r.aksi === 'create' && r.tabel === 'users' && String(r.row_id) === String(userId),
  );
  const mentah = JSON.stringify(entri.after_data);
  assert.ok(!mentah.includes('kata-sandi-uji-123'), 'nilai password tidak boleh masuk log');
  assert.ok(!/password/i.test(mentah), 'kunci password tidak boleh ikut dalam after_data');
  assert.equal(entri.after_data.username, namaUser);

  const hapus = await request(base).delete(`/user/${userId}`).set(auth);
  assert.equal(hapus.status, 200, `body: ${hapus.text}`);
  await tungguMuncul((rows) => rows.some(
    (r) => r.aksi === 'delete' && r.tabel === 'users' && String(r.row_id) === String(userId),
  ));
  userId = null;
});

test('POST /login sukses → entri LOGIN tercatat dgn aktor pemakai', async () => {
  const login = await request(base).post('/login')
    .send({ username: 'garap', password: env.ADMIN_PASSWORD });
  assert.equal(login.status, 200, 'kredensial admin dari .env harus diterima');

  const baris = await tungguMuncul((rows) => rows.some((r) => r.aksi === 'login'));
  const entri = baris.find((r) => r.aksi === 'login');
  assert.ok(entri, 'baris audit LOGIN wajib ada');
  assert.equal(entri.actor_label, 'garap');
  assert.equal(entri.tabel, 'users');
  assert.ok(entri.row_id, 'row_id = id akun yang masuk');
  const mentah = JSON.stringify(entri.after_data);
  assert.ok(!/password/i.test(mentah), 'LOGIN tidak boleh menyimpan password');
});

test('Pagination & filter: page/per_page/tabel/aksi + 422 untuk parameter cacat', async () => {
  const satu = await ambil({ per_page: 1, page: 1 });
  assert.equal(satu.status, 200);
  assert.deepEqual(
    Object.keys(satu.body).sort(),
    ['data', 'page', 'per_page', 'total'],
    'bentuk balasan kontrak {data,total,page,per_page}',
  );
  assert.equal(satu.body.page, 1);
  assert.equal(satu.body.per_page, 1);
  assert.equal(satu.body.data.length, 1, 'per_page=1 → tepat satu baris bila total ≥ 1');
  assert.ok(satu.body.total >= 2, `total minimal 2 (ada CREATE + DELETE), kini ${satu.body.total}`);

  const dua = await ambil({ per_page: 1, page: 2 });
  assert.equal(dua.status, 200);
  assert.equal(dua.body.page, 2);
  assert.equal(dua.body.data.length, 1, 'halaman 2 dengan per_page=1 tetap terisi');
  assert.notEqual(
    String(dua.body.data[0].id), String(satu.body.data[0].id),
    'halaman berbeda tidak boleh menampilkan baris yang sama',
  );

  // Filter tabel: SEMUA baris wajib tabel yang diminta.
  const fltTabel = await ambil({ tabel: 'mejas', per_page: 50 });
  assert.equal(fltTabel.status, 200);
  assert.ok(fltTabel.body.data.length > 0, 'harus ada jejak aksi /meja dari tes sebelumnya');
  assert.ok(fltTabel.body.data.every((r) => r.tabel === 'mejas'));

  // Filter aksi: SEMUA baris wajib aksi yang diminta.
  const fltAksi = await ambil({ aksi: 'create', per_page: 50 });
  assert.equal(fltAksi.status, 200);
  assert.ok(fltAksi.body.data.length > 0);
  assert.ok(fltAksi.body.data.every((r) => r.aksi === 'create'));

  // Parameter cacat → 422 terstruktur kontrak (bukan 500, bukan diabaikan).
  for (const q of [{ page: 'abc' }, { per_page: 0 }, { per_page: 9999 },
    { tabel: 'mejas; DROP TABLE users' }, { aksi: 'CREATE OR 1=1' }]) {
    const res = await ambil(q);
    assert.equal(res.status, 422, `query ${JSON.stringify(q)} harus 422, kini ${res.status}`);
    assert.equal(res.body.message, 'Data tidak valid.');
    const kunci = Object.keys(q)[0];
    assert.ok(Array.isArray(res.body.errors[kunci]), `errors.${kunci} wajib ada`);
  }
});
