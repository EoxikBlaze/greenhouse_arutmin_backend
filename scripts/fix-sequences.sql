-- Perbaikan sequence PostgreSQL setelah restore/import dump Laravel.
-- Gejala: INSERT lewat API balas 500 {"message":"Terjadi kesalahan pada server."}
--          (di log psql: duplicate key value violates unique constraint ..._pkey)
-- Penyebab: sequence tidak ikut terangkat saat data diimpor dengan id eksplisit.
-- Aman: hanya MENGANGKAT sequence sampai max(id) — tidak menyentuh baris mana pun.
--
-- Jalankan:  psql "$DATABASE_URL" -f scripts/fix-sequences.sql

DO $$
DECLARE r record; mx bigint; before_lv bigint;
BEGIN
  FOR r IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_default LIKE 'nextval(%'
    ORDER BY table_name
  LOOP
    EXECUTE format('SELECT max(%I) FROM %I', r.column_name, r.table_name) INTO mx;
    CONTINUE WHEN mx IS NULL;
    EXECUTE format('SELECT last_value FROM %s',
                   pg_get_serial_sequence(r.table_name, r.column_name)) INTO before_lv;
    IF before_lv < mx THEN
      EXECUTE format('SELECT setval(pg_get_serial_sequence(%L, %L), %s)',
                     r.table_name, r.column_name, mx);
      RAISE NOTICE 'FIX %-20s sequence % -> % (max(id)=%)',
                   r.table_name, before_lv, mx, mx;
    END IF;
  END LOOP;
END $$;
