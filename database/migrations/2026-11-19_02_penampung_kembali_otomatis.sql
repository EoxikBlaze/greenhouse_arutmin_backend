-- 19 Nov 2026 — Menu Target Nutrisi (mode Manual per penampung, kirim TARGET manual) dihapus dari web.
-- Penampung yang masih bermode 'manual' dikembalikan ke 'otomatis' supaya targetnya mengikuti resep batch;
-- tanpa menu itu tidak ada lagi cara mengembalikannya dari web. Tidak menghapus data (hanya target_mode).
UPDATE penampung_states SET target_mode = 'otomatis', updated_at = now() WHERE target_mode = 'manual';
