-- Injeksi 100.000 data sensor uji (water_level = 'Load-Test' sebagai penanda),
-- tersebar 60 hari ke belakang untuk simulasi data nyata.
INSERT INTO monitorings ("waterTemp", ph, tds, "airTemp", humidity, water_level, created_at, updated_at)
SELECT
  25 + random() * 3,
  5.8 + random() * 1.2,
  900 + random() * 350,
  29 + random() * 4,
  58 + random() * 18,
  'Load-Test',
  now() - (random() * interval '60 days'),
  now()
FROM generate_series(1, 100000);
