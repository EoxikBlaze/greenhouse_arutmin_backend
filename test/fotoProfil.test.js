'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { BATAS_BYTE, deteksiTipe, periksaUnggahan } = require('../src/fotoProfil');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);

test('deteksiTipe mengenali PNG, JPEG, WebP dari byte awal', () => {
  assert.equal(deteksiTipe(PNG), 'image/png');
  assert.equal(deteksiTipe(JPEG), 'image/jpeg');
  assert.equal(deteksiTipe(WEBP), 'image/webp');
});

test('deteksiTipe menolak GIF, SVG, HTML, kosong, dan non-Buffer', () => {
  assert.equal(deteksiTipe(Buffer.from('GIF89a' + 'x'.repeat(20))), null);
  assert.equal(deteksiTipe(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')), null);
  assert.equal(deteksiTipe(Buffer.from('<html><body>x</body></html>')), null);
  assert.equal(deteksiTipe(Buffer.alloc(0)), null);
  assert.equal(deteksiTipe('PNG'), null);
  assert.equal(deteksiTipe(null), null);
});

test('periksaUnggahan: kosong 415, terlalu besar 413, bukan gambar 422, valid ok', () => {
  assert.equal(periksaUnggahan(undefined).status, 415);
  assert.equal(periksaUnggahan(Buffer.alloc(0)).status, 415);
  assert.equal(periksaUnggahan({}).status, 415); // body JSON/objek, bukan Buffer
  const besar = Buffer.concat([PNG, Buffer.alloc(BATAS_BYTE)]);
  assert.equal(periksaUnggahan(besar).status, 413);
  assert.equal(periksaUnggahan(Buffer.from('bukan gambar sama sekali')).status, 422);
  assert.deepEqual(periksaUnggahan(JPEG), { ok: true, tipe: 'image/jpeg' });
});

test('periksaUnggahan: tipe dari isi berkas, bukan dari klaim klien', () => {
  // HTML yang dikirim seolah gambar tetap ditolak
  assert.equal(periksaUnggahan(Buffer.from('<script>alert(1)</script>' + ' '.repeat(20))).ok, false);
});
