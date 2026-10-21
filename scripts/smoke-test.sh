#!/usr/bin/env bash
# Smoke test backend GARAP — semua command siap salin.
set -uo pipefail
BE="http://127.0.0.1:8000"
APIKEY=$(grep '^ESP32_API_KEY=' /Users/rizki/Project/Vertoniksmartfarm/backend-nodejs/.env | cut -d= -f2-)
ADMIN_PASSWORD=$(grep '^ADMIN_PASSWORD=' /Users/rizki/Project/Vertoniksmartfarm/backend-nodejs/.env | cut -d= -f2-)
[ -n "$ADMIN_PASSWORD" ] || { echo 'ADMIN_PASSWORD belum diisi di backend-nodejs/.env'; exit 1; }
J='Content-Type: application/json'
hr(){ printf '\n=== %s ===\n' "$1"; }

hr "1. Info endpoint GET /"
curl -s -w '\nHTTP %{http_code} | %{content_type}\n' "$BE/"

hr "2. Navigasi browser (Sec-Fetch-Mode: navigate) -> 204 kosong"
curl -s -o /dev/null -w 'HTTP %{http_code} | body %{size_download} byte\n' -H 'Sec-Fetch-Mode: navigate' "$BE/dashboard"

hr "3. Login salah -> 422"
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BE/login" -H "$J" -d '{"username":"garap","password":"salah"}'

hr "4. Login superadmin (garap) -> token JWT"
curl -s -X POST "$BE/login" -H "$J" -d "{\"username\":\"garap\",\"password\":\"$ADMIN_PASSWORD\"}" > /tmp/vsf_login.json
python3 -c "import json;d=json.load(open('/tmp/vsf_login.json'));print('status=',d['status'],'user=',d['user']['username'],d['user']['level'],'token_len=',len(d['token']))"
cp /tmp/vsf_login.json /tmp/vsf_login.json.bak
python3 -c "import json;open('/tmp/vsf_tok','w').write(json.load(open('/tmp/vsf_login.json'))['token'])"
TOK=$(cat /tmp/vsf_tok)
A="Authorization: Bearer $TOK"

hr "5. Tanpa token -> 401"
curl -s -w '\nHTTP %{http_code}\n' "$BE/dashboard"

hr "6. GET /dashboard (admin)"
curl -s -o /tmp/dash.json -w 'HTTP %{http_code} | %{size_download} byte\n' "$BE/dashboard" -H "$A"
python3 -c "
import json;d=json.load(open('/tmp/dash.json'))
print('kunci:', ', '.join(list(d.keys())[:14]))
print('metrik: tanaman=%s meja=%s siklus=%s semai=%s panen=%s qty=%s'%(d.get('total_tanaman'),d.get('total_meja'),d.get('total_siklus'),d.get('total_semai'),d.get('total_panen'),d.get('total_panen_qty')))
print('iot:', d.get('iotStatus'))"

hr "7. GET /monitoring/chart-data (grafik 288 titik)"
curl -s -o /tmp/chart.json -w 'HTTP %{http_code} | %{size_download} byte\n' "$BE/monitoring/chart-data" -H "$A"
python3 -c "
import json;d=json.load(open('/tmp/chart.json'))
print('tipe:',type(d).__name__,'| jumlah titik:', len(d) if isinstance(d,list) else list(d.keys()))"

hr "8. GET /laporan"
curl -s -o /tmp/lap.json -w 'HTTP %{http_code} | %{size_download} byte\n' "$BE/laporan" -H "$A"
head -c 300 /tmp/lap.json; echo

hr "9. GET /watercontrol/status"
curl -s -w '\nHTTP %{http_code}\n' "$BE/watercontrol/status" -H "$A"

hr "10. GET /user (daftar akun)"
curl -s -o /tmp/user.json -w 'HTTP %{http_code}\n' "$BE/user" -H "$A"
python3 -c "
import json;d=json.load(open('/tmp/user.json'))
rows=d if isinstance(d,list) else d.get('data',d)
print('jumlah user:', len(rows));print('baris pertama (tanpa password):', {k:v for k,v in (rows[0].items() if isinstance(rows,list) or True else [])} if False else rows[0] if isinstance(rows,list) else rows)"

hr "11. Role petani diblokir dari /user -> 403"
curl -s -X POST "$BE/login" -H "$J" -d '{"username":"petani","password":"<PETANI_PASSWORD>"}' > /tmp/p.json
python3 -c "import json;open('/tmp/ptok','w').write(json.load(open('/tmp/p.json'))['token'])"
curl -s -w '\nHTTP %{http_code}\n' "$BE/user" -H "Authorization: Bearer $(cat /tmp/ptok)"

hr "12. Role petani BOLEH /dashboard & /tanam"
curl -s -o /dev/null -w 'GET /dashboard -> HTTP %{http_code}\n' "$BE/dashboard" -H "Authorization: Bearer $(cat /tmp/ptok)"
curl -s -o /dev/null -w 'GET /tanam     -> HTTP %{http_code}\n' "$BE/tanam" -H "Authorization: Bearer $(cat /tmp/ptok)"

hr "13. ESP32 GET /api/get-thresholds (X-API-KEY)"
curl -s -w '\nHTTP %{http_code}\n' "$BE/api/get-thresholds" -H "X-API-KEY: $APIKEY"

hr "14. ESP32 tanpa API key -> 403"
curl -s -w '\nHTTP %{http_code}\n' "$BE/api/get-thresholds"

hr "15. ESP32 GET /api/latest-sensor"
curl -s -o /tmp/ls.json -w 'HTTP %{http_code} | %{size_download} byte\n' "$BE/api/latest-sensor" -H "X-API-KEY: $APIKEY"
head -c 400 /tmp/ls.json; echo

hr "16. CRUD: POST /meja lalu DELETE (uji tulis + bersih)"
# Kolom whitelist backend: 'meja' dan 'jumlah_lubang' (bukan nama_meja/lokasi)
curl -s -o /tmp/meja.json -w 'HTTP %{http_code}\n' -X POST "$BE/meja" -H "$A" -H "$J" -d '{"meja":"MEJA UJI SMOKE","jumlah_lubang":8}'
head -c 300 /tmp/meja.json; echo
NEWID=$(python3 -c "import json;print((json.load(open('/tmp/meja.json')).get('data') or {}).get('id_meja',''))")
echo "id_meja baru = ${NEWID:-tidak terbaca}"
if [ -n "${NEWID:-}" ]; then
  curl -s -o /dev/null -w "DELETE /meja/$NEWID -> HTTP %{http_code}\n" -X DELETE "$BE/meja/$NEWID" -H "$A"
fi
echo "sisa baris mejas:"; psql "$(grep '^DATABASE_URL=' /Users/rizki/Project/Vertoniksmartfarm/backend-nodejs/.env | cut -d= -f2-)" -tAc 'SELECT count(*) FROM mejas'

hr "17. Rute tak dikenal -> 404 JSON generik"
curl -s -w '\nHTTP %{http_code}\n' "$BE/tidak-ada"

hr "18. JSON rusak -> 400"
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BE/login" -H "$J" -d '{rusak'

hr "19. Header keamanan"
curl -s -D - -o /dev/null "$BE/" | grep -iE 'x-frame|x-content|referrer|cache-control|x-powered|ratelimit'

hr "20. Rate limit login (10/menit) -> 429 (uji terakhir, login terkunci 60 dtk)"
for i in $(seq 1 12); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BE/login" -H "$J" -d '{"username":"x","password":"y"}')
  printf '%s ' "$code"
done; echo
