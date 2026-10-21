--
-- PostgreSQL database dump
--

\restrict JbAim446yCLJqgm7xgIfQgkf40gfYzoK2khbslMk8IubdWX47fRdCz5AAwCofZX

-- Dumped from database version 17.11 (Homebrew)
-- Dumped by pg_dump version 17.11 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: sensor_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_overrides (
    id bigint NOT NULL,
    id_meja bigint NOT NULL,
    field character varying(24) NOT NULL,
    nilai numeric(8,3) NOT NULL,
    satuan character varying(12),
    alasan text NOT NULL,
    status character varying(12) DEFAULT 'aktif'::character varying NOT NULL,
    mulai_pada timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    berakhir_pada timestamp(0) without time zone,
    durasi_rencana_menit integer,
    dibuat_oleh bigint NOT NULL,
    dipicu_dari character varying(16) DEFAULT 'web'::character varying NOT NULL,
    dihentikan_pada timestamp(0) without time zone,
    dihentikan_oleh bigint,
    alasan_penutup text,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT sensor_overrides_alasan_check CHECK ((length(btrim(alasan)) >= 5)),
    CONSTRAINT sensor_overrides_field_check CHECK (((field)::text = ANY ((ARRAY['ph'::character varying, 'ec_ms_cm'::character varying, 'suhu_air_c'::character varying, 'suhu_ruangan_c'::character varying, 'kelembapan_pct'::character varying])::text[]))),
    CONSTRAINT sensor_overrides_status_check CHECK (((status)::text = ANY ((ARRAY['aktif'::character varying, 'selesai'::character varying, 'dibatalkan'::character varying])::text[]))),
    CONSTRAINT sensor_overrides_tutup_check CHECK ((((status)::text = 'aktif'::text) OR (dihentikan_pada IS NOT NULL))),
    CONSTRAINT sensor_overrides_waktu_check CHECK (((berakhir_pada IS NULL) OR (berakhir_pada > mulai_pada)))
);


--
-- Name: TABLE sensor_overrides; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sensor_overrides IS 'OVERRIDE bacaan sensor per meja (siapa/kapan/kena berapa lama/field apa) — mengalahkan nilai sensor pada pembacaan efektif; 1 aktif per (id_meja, field)';


--
-- Name: COLUMN sensor_overrides.field; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sensor_overrides.field IS 'Field yang ditimpa — harus satu dari kolom metrik sensor_readings';


--
-- Name: COLUMN sensor_overrides.nilai; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sensor_overrides.nilai IS 'Nilai manual; divalidasi aplikasi terhadap sensor_thresholds.sanity_min/max sebelum INSERT (rangkaian: sanity -> override -> deadband/ambang)';


--
-- Name: COLUMN sensor_overrides.berakhir_pada; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sensor_overrides.berakhir_pada IS 'NULL = aktif sampai dihentikan manual; selain itu = auto-selesai (durasi aktif)';


--
-- Name: COLUMN sensor_overrides.dibuat_oleh; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sensor_overrides.dibuat_oleh IS 'WAJIB — user yang membuat override (role diizinkan = keputusan user; saran: admin saja)';


--
-- Name: fn_override_aktif(bigint, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_override_aktif(p_id_meja bigint, p_field character varying) RETURNS SETOF public.sensor_overrides
    LANGUAGE sql STABLE
    AS $$
    SELECT * FROM sensor_overrides
    WHERE id_meja = p_id_meja
      AND field = p_field
      AND status = 'aktif'
      AND mulai_pada <= CURRENT_TIMESTAMP
      AND (berakhir_pada IS NULL OR berakhir_pada > CURRENT_TIMESTAMP);
$$;


--
-- Name: FUNCTION fn_override_aktif(p_id_meja bigint, p_field character varying); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.fn_override_aktif(p_id_meja bigint, p_field character varying) IS 'Ambil nilai override AKTIF untuk (id_meja, field) — dipakai view v_bacaan_efektif';


--
-- Name: fn_partisi_readings_bulanan(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_partisi_readings_bulanan(target date) RETURNS text
    LANGUAGE plpgsql
    AS $_$
-- Membuat partisi bulanan sensor_readings_<yyyy_mm> bila belum ada.
-- target = tanggal mana pun dalam bulan yang diinginkan.
-- Bila ada DEFAULT partition, ia di-DETACH dulu, baris yang jatuh di rentang
-- target dipindahkan ke partisi baru, lalu DEFAULT di-ATTACH kembali
-- (ATTACH VALIDATION lolos karena rentang sudah bersih). Aman diulang.
DECLARE
    nama text := 'sensor_readings_' || to_char(target, 'YYYY_MM');
    awal date := date_trunc('month', target)::date;
    akhir date := (date_trunc('month', target) + interval '1 month')::date;
    ada_default boolean;
BEGIN
    IF to_regclass('public.' || nama) IS NOT NULL THEN
        RETURN nama;                       -- sudah ada, tidak berbuat apa-apa
    END IF;

    ada_default := to_regclass('public.sensor_readings_default') IS NOT NULL;
    IF ada_default THEN
        EXECUTE 'ALTER TABLE public.sensor_readings DETACH PARTITION public.sensor_readings_default';
    END IF;

    EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.sensor_readings
         FOR VALUES FROM (%L) TO (%L)', nama, awal, akhir);

    IF ada_default THEN
        -- angkut baris telat (bila ada) dari partisi default ke partisi baru
        EXECUTE 'INSERT INTO public.sensor_readings
                   (id, id_meja, device_id, created_at, ph, ec_ms_cm,
                    suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level,
                    valid, alasan_invalid, sumber)
                 SELECT id, id_meja, device_id, created_at, ph, ec_ms_cm,
                        suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level,
                        valid, alasan_invalid, sumber
                   FROM public.sensor_readings_default
                  WHERE created_at >= $1 AND created_at < $2'
            USING awal, akhir;
        EXECUTE 'DELETE FROM public.sensor_readings_default
                  WHERE created_at >= $1 AND created_at < $2' USING awal, akhir;
        EXECUTE 'ALTER TABLE public.sensor_readings
                 ATTACH PARTITION public.sensor_readings_default DEFAULT';
    END IF;

    RETURN nama;
END;
$_$;


--
-- Name: FUNCTION fn_partisi_readings_bulanan(target date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.fn_partisi_readings_bulanan(target date) IS 'Buat partisi bulanan sensor_readings (retensi = DROP partisi; AUDIT_PERFORMA_GARAP.md saran indeks (id_meja, created_at DESC))';


--
-- Name: fn_pensiun_readings(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_pensiun_readings(lama_hari integer) RETURNS integer
    LANGUAGE plpgsql
    AS $_$
-- Retensi: DETACH + DROP partisi yang berakhir lebih dari lama_hari lalu.
-- DETACH dulu (cepat, tidak memindahkan baris) lalu DROP (instan, tanpa
-- VACUUM/bloat seperti DELETE besar-besahan — lihat dokumen butir 1, opsi A).
-- Mengembalikan jumlah partisi yang dipensiunkan.
DECLARE
    r record;
    n integer := 0;
BEGIN
    FOR r IN
        SELECT c.relname
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'public.sensor_readings'::regclass
          AND c.relname <> 'sensor_readings_default'
          AND c.relname ~ 'sensor_readings_[0-9]{4}_[0-9]{2}$'
          AND (to_date(substring(c.relname from '([0-9]{4}_[0-9]{2})$'), 'YYYY_MM')
               + interval '1 month')::date <= now()::date - lama_hari
    LOOP
        EXECUTE format('ALTER TABLE public.sensor_readings DETACH PARTITION public.%I', r.relname);
        EXECUTE format('DROP TABLE public.%I', r.relname);
        n := n + 1;
    END LOOP;
    RETURN n;
END;
$_$;


--
-- Name: FUNCTION fn_pensiun_readings(lama_hari integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.fn_pensiun_readings(lama_hari integer) IS 'Retensi bacaan sensor: buang partisi mentah lebih tua dari N hari (rollup hourly TIDAK ikut terbuang)';


--
-- Name: fn_rollup_readings(timestamp without time zone, timestamp without time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_rollup_readings(jam_awal timestamp without time zone, jam_akhir timestamp without time zone) RETURNS integer
    LANGUAGE plpgsql
    AS $$
-- Hitung ulang rollup hourly untuk rentang [jam_awal, jam_akhir) — idempoten
-- (ON CONFLICT DO UPDATE), aman dipanggil berulang. Mengembalikan baris rollup.
DECLARE
    n integer;
BEGIN
    INSERT INTO sensor_readings_hourly (
        id_meja, bucket_start, n_bacaan, n_valid, n_override,
        ph_avg, ph_min, ph_max,
        ec_avg, ec_min, ec_max,
        suhu_air_avg, suhu_air_min, suhu_air_max,
        suhu_ruangan_avg, kelembapan_avg, dihitung_pada)
    SELECT r.id_meja,
           date_trunc('hour', r.created_at),
           count(*),
           count(*) FILTER (WHERE r.valid),
           count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM sensor_overrides o
               WHERE o.id_meja = r.id_meja
                 AND o.status <> 'dibatalkan'
                 AND o.mulai_pada <= r.created_at
                 AND r.created_at < LEAST(COALESCE(o.berakhir_pada, 'infinity'::timestamp),
                                          COALESCE(o.dihentikan_pada, 'infinity'::timestamp)))),
           round(avg(r.ph)::numeric, 2), min(r.ph), max(r.ph),
           round(avg(r.ec_ms_cm)::numeric, 3), min(r.ec_ms_cm), max(r.ec_ms_cm),
           round(avg(r.suhu_air_c)::numeric, 2), min(r.suhu_air_c), max(r.suhu_air_c),
           round(avg(r.suhu_ruangan_c)::numeric, 2),
           round(avg(r.kelembapan_pct)::numeric, 2),
           CURRENT_TIMESTAMP
    FROM sensor_readings r
    WHERE r.created_at >= jam_awal AND r.created_at < jam_akhir
    GROUP BY r.id_meja, date_trunc('hour', r.created_at)
    ON CONFLICT (id_meja, bucket_start) DO UPDATE
        SET n_bacaan = EXCLUDED.n_bacaan,
            n_valid = EXCLUDED.n_valid,
            n_override = EXCLUDED.n_override,
            ph_avg = EXCLUDED.ph_avg, ph_min = EXCLUDED.ph_min, ph_max = EXCLUDED.ph_max,
            ec_avg = EXCLUDED.ec_avg, ec_min = EXCLUDED.ec_min, ec_max = EXCLUDED.ec_max,
            suhu_air_avg = EXCLUDED.suhu_air_avg, suhu_air_min = EXCLUDED.suhu_air_min, suhu_air_max = EXCLUDED.suhu_air_max,
            suhu_ruangan_avg = EXCLUDED.suhu_ruangan_avg,
            kelembapan_avg = EXCLUDED.kelembapan_avg,
            dihitung_pada = EXCLUDED.dihitung_pada;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$;


--
-- Name: FUNCTION fn_rollup_readings(jam_awal timestamp without time zone, jam_akhir timestamp without time zone); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.fn_rollup_readings(jam_awal timestamp without time zone, jam_akhir timestamp without time zone) IS 'Rollup idempoten per jam per meja — dipanggil job terjadwal (tiap jam + saat backfill)';


--
-- Name: alert_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_logs (
    id bigint NOT NULL,
    type character varying(50) NOT NULL,
    value character varying(100) NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(0) without time zone,
    id_meja bigint,
    severity character varying(20) DEFAULT 'info'::character varying NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    acknowledged boolean DEFAULT false NOT NULL,
    acknowledged_at timestamp without time zone,
    CONSTRAINT alert_logs_severity_check CHECK (((severity)::text = ANY ((ARRAY['info'::character varying, 'warning'::character varying, 'critical'::character varying])::text[])))
);


--
-- Name: COLUMN alert_logs.severity; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.alert_logs.severity IS 'info | warning | critical — Perancangan FINAL Aturan 9 (INFO dini vs ALERT vs LOCK)';


--
-- Name: COLUMN alert_logs.locked; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.alert_logs.locked IS 'TRUE bila alert memicu LOCK dosing penampung (Aturan 9 par.152: alert 3, 4, 6)';


--
-- Name: COLUMN alert_logs.acknowledged; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.alert_logs.acknowledged IS 'Ditandai dibaca petani (reset LOCK dilakukan petani — Aturan 9 par.152)';


--
-- Name: alert_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.alert_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: alert_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alert_logs_id_seq OWNED BY public.alert_logs.id;


--
-- Name: aturan_fail_safe; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aturan_fail_safe (
    kode character varying(24) NOT NULL,
    kondisi text NOT NULL,
    aksi text NOT NULL,
    ambang numeric(12,3),
    satuan character varying(24),
    aktif boolean DEFAULT true NOT NULL,
    sumber character varying(120)
);


--
-- Name: TABLE aturan_fail_safe; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.aturan_fail_safe IS 'Fail-safe & pemicu alert/LOCK — Perancangan FINAL seksi 5 (Aturan 9-14) + seksi 9';


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id bigint NOT NULL,
    terjadi_pada timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    actor_user_id bigint,
    actor_tipe character varying(16) DEFAULT 'user'::character varying NOT NULL,
    actor_label character varying(120),
    aksi character varying(32) NOT NULL,
    tabel character varying(64),
    row_id character varying(64),
    before_data jsonb,
    after_data jsonb,
    ip inet,
    user_agent text,
    request_id uuid,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT audit_logs_actor_tipe_check CHECK (((actor_tipe)::text = ANY ((ARRAY['user'::character varying, 'system'::character varying, 'esp32'::character varying, 'api_key'::character varying, 'anonymous'::character varying])::text[]))),
    CONSTRAINT audit_logs_aksi_check CHECK (((aksi)::text = ANY ((ARRAY['create'::character varying, 'update'::character varying, 'delete'::character varying, 'login'::character varying, 'logout'::character varying, 'login_failed'::character varying, 'override_start'::character varying, 'override_stop'::character varying, 'command'::character varying, 'export'::character varying, 'reset_lock'::character varying, 'maintenance_on'::character varying, 'maintenance_off'::character varying, 'config_change'::character varying, 'report_generate'::character varying])::text[]))),
    CONSTRAINT audit_logs_target_check CHECK ((((aksi)::text <> ALL ((ARRAY['create'::character varying, 'update'::character varying, 'delete'::character varying])::text[])) OR ((tabel IS NOT NULL) AND (row_id IS NOT NULL)))),
    CONSTRAINT audit_logs_user_check CHECK ((((actor_tipe)::text <> 'user'::text) OR (actor_user_id IS NOT NULL)))
);


--
-- Name: TABLE audit_logs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.audit_logs IS 'Audit trail generik: siapa (user/system/ESP32) melakukan apa, di tabel/row mana, before/after JSONB, IP + user agent — retensi default 365 hari (keputusan user)';


--
-- Name: COLUMN audit_logs.actor_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_logs.actor_user_id IS 'NULL = sistem/ESP32/anonymous (actor_tipe menjelaskan); ON DELETE SET NULL agar jejak tetap ada walau user dihapus';


--
-- Name: COLUMN audit_logs.actor_label; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_logs.actor_label IS 'Snapshot username / nama API key saat peristiwa (tahan rename/delete user)';


--
-- Name: COLUMN audit_logs.before_data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_logs.before_data IS 'Baris SEBELUM perubahan (UPDATE/DELETE); INSERT boleh NULL. Diambil dari row yang sudah di-load / RETURNING — TANPA SELECT tambahan';


--
-- Name: COLUMN audit_logs.request_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_logs.request_id IS 'Korelasi satu request → banyak baris audit (middleware membuat UUID per request)';


--
-- Name: audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.audit_logs ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cache (
    key character varying(255) NOT NULL,
    value text NOT NULL,
    expiration bigint NOT NULL
);


--
-- Name: cache_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cache_locks (
    key character varying(255) NOT NULL,
    owner character varying(255) NOT NULL,
    expiration bigint NOT NULL
);


--
-- Name: dosing_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dosing_events (
    id bigint NOT NULL,
    id_meja bigint NOT NULL,
    hari date NOT NULL,
    mulai_pada timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    selesai_pada timestamp(0) without time zone,
    durasi_detik integer,
    pemicu character varying(24) NOT NULL,
    aktor_tipe character varying(16) DEFAULT 'esp32'::character varying NOT NULL,
    dipicu_oleh bigint,
    alasan text,
    ronde_total smallint DEFAULT 0 NOT NULL,
    volume_total_ml numeric(8,2) DEFAULT 0 NOT NULL,
    ec_sebelum numeric(5,3),
    ec_sesudah numeric(5,3),
    target_ec numeric(5,3),
    hasil character varying(16) DEFAULT 'berjalan'::character varying NOT NULL,
    lock_terpicu boolean DEFAULT false NOT NULL,
    id_alert bigint,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT dosing_events_aktor_check CHECK (((aktor_tipe)::text = ANY ((ARRAY['user'::character varying, 'esp32'::character varying, 'system'::character varying])::text[]))),
    CONSTRAINT dosing_events_aktor_check2 CHECK (((((pemicu)::text = 'USER_MANUAL'::text) AND ((aktor_tipe)::text = 'user'::text)) OR ((pemicu)::text <> 'USER_MANUAL'::text))),
    CONSTRAINT dosing_events_hari_check CHECK ((hari >= '2026-01-01'::date)),
    CONSTRAINT dosing_events_hasil_check CHECK (((hasil)::text = ANY ((ARRAY['berjalan'::character varying, 'sukses'::character varying, 'gagal'::character varying, 'lock'::character varying, 'timeout'::character varying, 'dibatalkan'::character varying])::text[]))),
    CONSTRAINT dosing_events_manual_check CHECK ((((pemicu)::text <> 'USER_MANUAL'::text) OR (dipicu_oleh IS NOT NULL))),
    CONSTRAINT dosing_events_pemicu_check CHECK (((pemicu)::text = ANY ((ARRAY['ESP32_OTOMATIS'::character varying, 'USER_MANUAL'::character varying, 'SISTEM'::character varying, 'API'::character varying])::text[]))),
    CONSTRAINT dosing_events_ronde_check CHECK (((ronde_total >= 0) AND (ronde_total <= 5))),
    CONSTRAINT dosing_events_volume_check CHECK ((volume_total_ml >= (0)::numeric)),
    CONSTRAINT dosing_events_waktu_check CHECK (((selesai_pada IS NULL) OR (selesai_pada >= mulai_pada)))
);


--
-- Name: TABLE dosing_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.dosing_events IS 'Log pemberian nutrisi: 1 baris = 1 KEJADIAN (sesi maks 5 suntikan + baca ulang) — Perancangan FINAL seksi 1.6/2.3, Aturan 6/7/9/11; pemicu ESP32 otomatis atau user manual';


--
-- Name: COLUMN dosing_events.hari; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dosing_events.hari IS 'Tanggal harian menurut reset 00:00 (RTC/WITA) — Aturan 11; kunci counter 8 kejadian/hari & 500 mL (Tabel 13)';


--
-- Name: COLUMN dosing_events.pemicu; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dosing_events.pemicu IS 'ESP32_OTOMATIS (Aturan 6) | USER_MANUAL (dari aplikasi) | SISTEM | API';


--
-- Name: COLUMN dosing_events.volume_total_ml; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dosing_events.volume_total_ml IS 'Turunan SUM(dosing_rounds.volume_ml) dihitung saat kejadian ditutup — dipakai counter harian tanpa JOIN (konsistensi via v_dosing_harian)';


--
-- Name: COLUMN dosing_events.hasil; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dosing_events.hasil IS 'sukses = target tercapai (-> MONITORING 60 mnt) | gagal = retry habis | lock = ALERT+LOCK (Aturan 9) | timeout | dibatalkan (isi air mendahului — Aturan 3)';


--
-- Name: dosing_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.dosing_events ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.dosing_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: dosing_rounds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dosing_rounds (
    id bigint NOT NULL,
    id_kejadian bigint NOT NULL,
    ronde_ke smallint NOT NULL,
    jenis character varying(12) NOT NULL,
    target_delta_ec numeric(5,3),
    volume_ml numeric(7,2) NOT NULL,
    durasi_pulse_detik numeric(6,2),
    volume_bilas_ml numeric(7,2),
    mulai_pada timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    selesai_pada timestamp(0) without time zone,
    ec_setelah numeric(5,3),
    retry_ke smallint,
    hasil character varying(12) DEFAULT 'ok'::character varying NOT NULL,
    catatan text,
    CONSTRAINT dosing_rounds_hasil_check CHECK (((hasil)::text = ANY ((ARRAY['ok'::character varying, 'gagal'::character varying, 'timeout'::character varying, 'dibatalkan'::character varying])::text[]))),
    CONSTRAINT dosing_rounds_jenis_check CHECK (((jenis)::text = ANY ((ARRAY['A'::character varying, 'B'::character varying, 'PH_UP'::character varying, 'PH_DOWN'::character varying])::text[]))),
    CONSTRAINT dosing_rounds_retry_check CHECK (((retry_ke IS NULL) OR ((retry_ke >= 1) AND (retry_ke <= 5)))),
    CONSTRAINT dosing_rounds_ronde_check CHECK (((ronde_ke >= 1) AND (ronde_ke <= 5))),
    CONSTRAINT dosing_rounds_volume_check CHECK (((volume_ml >= (0)::numeric) AND (volume_ml <= (500)::numeric)))
);


--
-- Name: TABLE dosing_rounds; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.dosing_rounds IS 'Detail suntikan/ronde dalam satu kejadian dosing (maks 5, Perancangan FINAL Aturan 6/7) — A/B/PH_UP/PH_DOWN, bilas, pulse, hasil';


--
-- Name: COLUMN dosing_rounds.volume_ml; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dosing_rounds.volume_ml IS 'Volume suntikan (Tabel 4 takaran pulse; pagar 500 mL/hari = konfigurasi_dosis.maks_volume_ab_hari_ml)';


--
-- Name: COLUMN dosing_rounds.retry_ke; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dosing_rounds.retry_ke IS 'Retry maks: EC 5x, pH 3x (Tabel 13 / konfigurasi_dosis.maks_retry_*)';


--
-- Name: dosing_rounds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.dosing_rounds ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.dosing_rounds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: failed_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.failed_jobs (
    id bigint NOT NULL,
    uuid character varying(255) NOT NULL,
    connection character varying(255) NOT NULL,
    queue character varying(255) NOT NULL,
    payload text NOT NULL,
    exception text NOT NULL,
    failed_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: failed_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.failed_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: failed_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.failed_jobs_id_seq OWNED BY public.failed_jobs.id;


--
-- Name: jadwal_perawatan; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jadwal_perawatan (
    kode character varying(24) NOT NULL,
    periode character varying(24) NOT NULL,
    periode_hari integer,
    kegiatan text NOT NULL,
    lama_menit integer,
    sumber character varying(120)
);


--
-- Name: TABLE jadwal_perawatan; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.jadwal_perawatan IS 'Jadwal perawatan rutin — Perancangan FINAL seksi 11 Tabel 14';


--
-- Name: job_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_batches (
    id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    total_jobs integer NOT NULL,
    pending_jobs integer NOT NULL,
    failed_jobs integer NOT NULL,
    failed_job_ids text NOT NULL,
    options text,
    cancelled_at integer,
    created_at integer NOT NULL,
    finished_at integer
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id bigint NOT NULL,
    queue character varying(255) NOT NULL,
    payload text NOT NULL,
    attempts smallint NOT NULL,
    reserved_at integer,
    available_at integer NOT NULL,
    created_at integer NOT NULL
);


--
-- Name: jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.jobs_id_seq OWNED BY public.jobs.id;


--
-- Name: kalibrasi_sensor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kalibrasi_sensor (
    sensor character varying(32) NOT NULL,
    metode text NOT NULL,
    larutan_ref character varying(64),
    nilai_ref numeric(10,3),
    satuan character varying(24),
    periode_hari_min integer,
    periode_hari_max integer,
    penyimpanan character varying(64),
    hasil_ukur numeric(10,3),
    terakhir_dikalibrasi timestamp without time zone,
    keterangan text,
    sumber character varying(120)
);


--
-- Name: TABLE kalibrasi_sensor; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.kalibrasi_sensor IS 'Kalibrasi & uji lapangan per parameter — Perancangan FINAL seksi 10 + Lampiran B par.252';


--
-- Name: konfigurasi_dosis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.konfigurasi_dosis (
    param character varying(64) NOT NULL,
    nilai numeric(12,4) NOT NULL,
    satuan character varying(24) NOT NULL,
    keterangan text,
    sumber character varying(120),
    diubah_pada timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: TABLE konfigurasi_dosis; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.konfigurasi_dosis IS 'Parameter dosis AB mix & pagar harian — Perancangan FINAL seksi 2.2/2.3 + Tabel 13';


--
-- Name: mapping_channel_esp32; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mapping_channel_esp32 (
    kode character varying(32) NOT NULL,
    kategori character varying(24) NOT NULL,
    nama character varying(80) NOT NULL,
    jumlah_channel smallint,
    pin_gpio character varying(40),
    keterangan text,
    sumber character varying(120)
);


--
-- Name: TABLE mapping_channel_esp32; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.mapping_channel_esp32 IS 'Pembagian channel & pin ESP32 — Perancangan FINAL Lampiran A Tabel 17 & Tabel 18';


--
-- Name: mejas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mejas (
    id_meja bigint NOT NULL,
    meja character varying(50) NOT NULL,
    jumlah_lubang integer NOT NULL,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    expires_at timestamp(0) without time zone,
    jenis_talang character varying(20),
    kapasitas_penampung_l numeric(6,2),
    jumlah_talang integer,
    lubang_per_talang integer,
    panjang_talang_m numeric(4,2),
    laju_per_talang_lpm numeric(5,2),
    kenaikan_air_cm integer DEFAULT 40,
    CONSTRAINT mejas_jenis_talang_check CHECK (((jenis_talang IS NULL) OR ((jenis_talang)::text = ANY ((ARRAY['NFT'::character varying, 'DFT'::character varying])::text[])))),
    CONSTRAINT mejas_kapasitas_penampung_l_check CHECK (((kapasitas_penampung_l IS NULL) OR (kapasitas_penampung_l > (0)::numeric)))
);


--
-- Name: COLUMN mejas.jenis_talang; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mejas.jenis_talang IS 'Perancangan FINAL seksi 1.2: NFT (Meja 1-3) / DFT (Meja 4)';


--
-- Name: COLUMN mejas.kapasitas_penampung_l; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mejas.kapasitas_penampung_l IS 'Perancangan FINAL Tabel 1: 70 L (Meja 1-3), 75 L (Meja 4)';


--
-- Name: COLUMN mejas.jumlah_talang; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mejas.jumlah_talang IS 'Perancangan FINAL Tabel 1: 12/8/10/10 talang';


--
-- Name: COLUMN mejas.lubang_per_talang; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mejas.lubang_per_talang IS 'Perancangan FINAL Tabel 1: 26/26/52/18 lubang per talang';


--
-- Name: COLUMN mejas.panjang_talang_m; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mejas.panjang_talang_m IS 'Perancangan FINAL Tabel 1: 8,1 m (Meja 4: 4 m)';


--
-- Name: COLUMN mejas.laju_per_talang_lpm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mejas.laju_per_talang_lpm IS 'Perancangan FINAL Tabel 1: 1 L/menit per talang; Meja 4 diisi pengguna (NULL)';


--
-- Name: COLUMN mejas.kenaikan_air_cm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mejas.kenaikan_air_cm IS 'Perancangan FINAL Tabel 1: kenaikan penampung -> meja = 40 cm';


--
-- Name: mejas_id_meja_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mejas_id_meja_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mejas_id_meja_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mejas_id_meja_seq OWNED BY public.mejas.id_meja;


--
-- Name: migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.migrations (
    id integer NOT NULL,
    migration character varying(255) NOT NULL,
    batch integer NOT NULL
);


--
-- Name: migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.migrations_id_seq OWNED BY public.migrations.id;


--
-- Name: monitorings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitorings (
    id bigint NOT NULL,
    "waterTemp" double precision,
    ph double precision,
    tds double precision,
    "airTemp" double precision,
    humidity double precision,
    water_level character varying(20),
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(0) without time zone,
    id_meja bigint,
    ec_ms_cm double precision
);


--
-- Name: COLUMN monitorings.id_meja; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.monitorings.id_meja IS 'Penampung/meja asal bacaan (Perancangan FINAL seksi 1.4 — sampling bergiliran 1->4); NULL = data lama';


--
-- Name: COLUMN monitorings.ec_ms_cm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.monitorings.ec_ms_cm IS 'EC sensor langsung mS/cm — Perancangan FINAL seksi 2.2 par.48 (ppm = EC x 500)';


--
-- Name: monitorings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.monitorings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: monitorings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.monitorings_id_seq OWNED BY public.monitorings.id;


--
-- Name: panens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.panens (
    id_panen bigint NOT NULL,
    id_pendewasaan bigint NOT NULL,
    panen_berhasil integer DEFAULT 0 NOT NULL,
    panen_gagal integer DEFAULT 0 NOT NULL,
    tgl_panen date NOT NULL,
    keterangan text,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    expires_at timestamp(0) without time zone
);


--
-- Name: panens_id_panen_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.panens_id_panen_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: panens_id_panen_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.panens_id_panen_seq OWNED BY public.panens.id_panen;


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    email character varying(255) NOT NULL,
    token character varying(255) NOT NULL,
    created_at timestamp(0) without time zone
);


--
-- Name: penampung_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.penampung_states (
    id_meja bigint NOT NULL,
    status_lock boolean DEFAULT false NOT NULL,
    lock_alasan character varying(100),
    lock_sejak timestamp without time zone,
    mode_pemeliharaan boolean DEFAULT false NOT NULL,
    kejadian_dosis_hari integer DEFAULT 0 NOT NULL,
    volume_ab_hari_ml numeric(8,2) DEFAULT 0 NOT NULL,
    volume_ph_hari_ml numeric(8,2) DEFAULT 0 NOT NULL,
    target_ec_ppm numeric(8,2),
    target_ph numeric(4,2),
    reset_harian_pada timestamp without time zone,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: TABLE penampung_states; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.penampung_states IS 'State per penampung (1 baris per meja): LOCK, counter harian, mode pemeliharaan, setpoint aktif — Perancangan FINAL seksi 1.1, Aturan 9/11/13';


--
-- Name: COLUMN penampung_states.mode_pemeliharaan; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.penampung_states.mode_pemeliharaan IS 'Perancangan FINAL Aturan 13: sampling & dosing dijeda, jatah dibekukan, isi air tetap jalan';


--
-- Name: COLUMN penampung_states.kejadian_dosis_hari; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.penampung_states.kejadian_dosis_hari IS 'Perancangan FINAL seksi 1.6: maks 8 kejadian dosing/hari, reset 00:00';


--
-- Name: COLUMN penampung_states.volume_ab_hari_ml; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.penampung_states.volume_ab_hari_ml IS 'Perancangan FINAL seksi 1.6/Tabel 13: maks 500 mL AB mix/hari (semua suntikan termasuk retry)';


--
-- Name: pendewasaans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pendewasaans (
    id_pendewasaan bigint NOT NULL,
    id_peremajaan bigint,
    id_meja bigint,
    tanaman_berhasil integer NOT NULL,
    tanaman_gagal integer NOT NULL,
    tgl_awal_pendewasaan date NOT NULL,
    tgl_akhir_pendewasaan date NOT NULL,
    keterangan text,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    expires_at timestamp(0) without time zone,
    jumlah_masuk integer
);


--
-- Name: pendewasaans_id_pendewasaan_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pendewasaans_id_pendewasaan_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pendewasaans_id_pendewasaan_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pendewasaans_id_pendewasaan_seq OWNED BY public.pendewasaans.id_pendewasaan;


--
-- Name: peremajaans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.peremajaans (
    id_peremajaan bigint NOT NULL,
    id_semai bigint,
    id_meja bigint,
    benih_berhasil integer NOT NULL,
    benih_gagal integer NOT NULL,
    tgl_awal_peremajaan date NOT NULL,
    tgl_akhir_peremajaan date NOT NULL,
    keterangan text,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    expires_at timestamp(0) without time zone,
    jumlah_masuk integer
);


--
-- Name: peremajaans_id_peremajaan_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.peremajaans_id_peremajaan_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: peremajaans_id_peremajaan_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.peremajaans_id_peremajaan_seq OWNED BY public.peremajaans.id_peremajaan;


--
-- Name: report_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_logs (
    id bigint NOT NULL,
    jenis character varying(32) NOT NULL,
    judul character varying(160),
    periode_dari date,
    periode_sampai date,
    filter jsonb DEFAULT '{}'::jsonb NOT NULL,
    format character varying(12) DEFAULT 'json'::character varying NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    dibuat_oleh bigint,
    aktor_tipe character varying(16) DEFAULT 'user'::character varying NOT NULL,
    dimulai_pada timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    selesai_pada timestamp(0) without time zone,
    durasi_ms integer,
    jumlah_baris integer,
    file_path text,
    file_size_bytes bigint,
    file_sha256 character varying(64),
    hasil_json jsonb,
    error_message text,
    ip inet,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT report_logs_aktor_check CHECK (((aktor_tipe)::text = ANY ((ARRAY['user'::character varying, 'system'::character varying, 'scheduler'::character varying])::text[]))),
    CONSTRAINT report_logs_format_check CHECK (((format)::text = ANY ((ARRAY['json'::character varying, 'csv'::character varying, 'pdf'::character varying, 'xlsx'::character varying])::text[]))),
    CONSTRAINT report_logs_gagal_check CHECK ((((status)::text <> 'gagal'::text) OR (error_message IS NOT NULL))),
    CONSTRAINT report_logs_jenis_check CHECK (((jenis)::text = ANY ((ARRAY['dashboard'::character varying, 'enam_jam'::character varying, 'chart'::character varying, 'harian'::character varying, 'mingguan'::character varying, 'bulanan'::character varying, 'csv_export'::character varying, 'custom'::character varying])::text[]))),
    CONSTRAINT report_logs_periode_check CHECK (((periode_dari IS NULL) OR (periode_sampai IS NULL) OR (periode_sampai >= periode_dari))),
    CONSTRAINT report_logs_selesai_check CHECK ((((status)::text <> 'selesai'::text) OR (selesai_pada IS NOT NULL))),
    CONSTRAINT report_logs_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'berjalan'::character varying, 'selesai'::character varying, 'gagal'::character varying])::text[]))),
    CONSTRAINT report_logs_user_check CHECK ((((aktor_tipe)::text = 'user'::text) OR (dibuat_oleh IS NULL)))
);


--
-- Name: TABLE report_logs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.report_logs IS 'Riwayat laporan: jenis, periode, filter, pembuat, waktu generate, status, referensi file/JSON — cukup untuk menjawab "siapa kapan membuat laporan apa" (audit performa: /laporan & getReport6Jam tanpa cache)';


--
-- Name: COLUMN report_logs.filter; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_logs.filter IS 'Filter mentah request (mis. {"id_meja":3,"dari":"2026-10-01"}) — bukti reproduksi laporan';


--
-- Name: COLUMN report_logs.file_path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_logs.file_path IS 'Path/URL file hasil ekspor (opsional — keputusan user: simpan file fisik atau hanya JSON)';


--
-- Name: report_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.report_logs ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.report_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: semais; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.semais (
    id_semai bigint NOT NULL,
    id_tanaman bigint,
    id_siklus bigint,
    jumlah_benih integer NOT NULL,
    tgl_awal_semai date NOT NULL,
    tgl_akhir_semai date NOT NULL,
    status character varying(255) DEFAULT 'proses'::character varying NOT NULL,
    keterangan text,
    benih_berhasil integer DEFAULT 0 NOT NULL,
    benih_gagal integer DEFAULT 0 NOT NULL,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    expires_at timestamp(0) without time zone,
    id_meja bigint,
    CONSTRAINT semais_status_check CHECK (((status)::text = ANY ((ARRAY['proses'::character varying, 'selesai'::character varying, 'gagal'::character varying])::text[])))
);


--
-- Name: semais_id_semai_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.semais_id_semai_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: semais_id_semai_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.semais_id_semai_seq OWNED BY public.semais.id_semai;


--
-- Name: sensor_overrides_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sensor_overrides ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.sensor_overrides_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sensor_readings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_readings (
    id bigint NOT NULL,
    id_meja bigint NOT NULL,
    device_id character varying(32) DEFAULT 'esp32-a'::character varying NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ph numeric(4,2),
    ec_ms_cm numeric(5,3),
    suhu_air_c numeric(4,2),
    suhu_ruangan_c numeric(4,2),
    kelembapan_pct numeric(5,2),
    water_level character varying(20),
    valid boolean DEFAULT true NOT NULL,
    alasan_invalid character varying(60),
    sumber character varying(16) DEFAULT 'ESP32'::character varying NOT NULL,
    CONSTRAINT sensor_readings_ec_check CHECK (((ec_ms_cm IS NULL) OR ((ec_ms_cm >= (0)::numeric) AND (ec_ms_cm <= (10)::numeric)))),
    CONSTRAINT sensor_readings_kelembapan_check CHECK (((kelembapan_pct IS NULL) OR ((kelembapan_pct >= (0)::numeric) AND (kelembapan_pct <= (100)::numeric)))),
    CONSTRAINT sensor_readings_ph_check CHECK (((ph IS NULL) OR ((ph >= (0)::numeric) AND (ph <= (14)::numeric)))),
    CONSTRAINT sensor_readings_suhu_air_check CHECK (((suhu_air_c IS NULL) OR ((suhu_air_c >= ('-10'::integer)::numeric) AND (suhu_air_c <= (80)::numeric)))),
    CONSTRAINT sensor_readings_suhu_ruangan_check CHECK (((suhu_ruangan_c IS NULL) OR ((suhu_ruangan_c >= ('-20'::integer)::numeric) AND (suhu_ruangan_c <= (60)::numeric)))),
    CONSTRAINT sensor_readings_sumber_check CHECK (((sumber)::text = ANY ((ARRAY['ESP32'::character varying, 'SIMULASI'::character varying, 'IMPORT'::character varying, 'MANUAL'::character varying])::text[]))),
    CONSTRAINT sensor_readings_valid_check CHECK ((valid OR (alasan_invalid IS NOT NULL)))
)
PARTITION BY RANGE (created_at);


--
-- Name: TABLE sensor_readings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sensor_readings IS 'Bacaan sensor PER MEJA (ph, EC mS/cm, suhu air, suhu ruangan, kelembapan) — Perancangan FINAL seksi 1.4/2.2; menggantikan monitorings (global 1 baris). Partisi bulanan + retensi DROP partisi (AUDIT_PERFORMA_GARAP.md: 17.280 baris/hari, proyeksi 84,6 MiB/30 hari).';


--
-- Name: COLUMN sensor_readings.device_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sensor_readings.device_id IS 'Perangkat penulis — kompatibel usulan 2 ESP32 (docs/KONTRAK_API.md seksi 6)';


--
-- Name: COLUMN sensor_readings.ec_ms_cm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sensor_readings.ec_ms_cm IS 'EC sensor langsung mS/cm — Perancangan FINAL seksi 2.2 par.48 (ppm = EC x 500)';


--
-- Name: COLUMN sensor_readings.valid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sensor_readings.valid IS 'FALSE = bacaan LOLOS input tetapi gagal sanity check (Perancangan FINAL seksi 4.1 par.60 / seksi 9 par.209) → tetap disimpan untuk audit, TIDAK dipakai perhitungan';


--
-- Name: COLUMN sensor_readings.alasan_invalid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sensor_readings.alasan_invalid IS 'Penyebab invalid: sanity_ec | sanity_ph | sanity_suhu | lonjakan_ec | timeout_baca (aturan di aturan_fail_safe)';


--
-- Name: COLUMN sensor_readings.sumber; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sensor_readings.sumber IS 'ESP32 (normal) | SIMULASI | IMPORT (backfill monitorings lama) | MANUAL (uji)';


--
-- Name: sensor_readings_2026_07; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_readings_2026_07 (
    id bigint NOT NULL,
    id_meja bigint NOT NULL,
    device_id character varying(32) DEFAULT 'esp32-a'::character varying NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ph numeric(4,2),
    ec_ms_cm numeric(5,3),
    suhu_air_c numeric(4,2),
    suhu_ruangan_c numeric(4,2),
    kelembapan_pct numeric(5,2),
    water_level character varying(20),
    valid boolean DEFAULT true NOT NULL,
    alasan_invalid character varying(60),
    sumber character varying(16) DEFAULT 'ESP32'::character varying NOT NULL,
    CONSTRAINT sensor_readings_ec_check CHECK (((ec_ms_cm IS NULL) OR ((ec_ms_cm >= (0)::numeric) AND (ec_ms_cm <= (10)::numeric)))),
    CONSTRAINT sensor_readings_kelembapan_check CHECK (((kelembapan_pct IS NULL) OR ((kelembapan_pct >= (0)::numeric) AND (kelembapan_pct <= (100)::numeric)))),
    CONSTRAINT sensor_readings_ph_check CHECK (((ph IS NULL) OR ((ph >= (0)::numeric) AND (ph <= (14)::numeric)))),
    CONSTRAINT sensor_readings_suhu_air_check CHECK (((suhu_air_c IS NULL) OR ((suhu_air_c >= ('-10'::integer)::numeric) AND (suhu_air_c <= (80)::numeric)))),
    CONSTRAINT sensor_readings_suhu_ruangan_check CHECK (((suhu_ruangan_c IS NULL) OR ((suhu_ruangan_c >= ('-20'::integer)::numeric) AND (suhu_ruangan_c <= (60)::numeric)))),
    CONSTRAINT sensor_readings_sumber_check CHECK (((sumber)::text = ANY ((ARRAY['ESP32'::character varying, 'SIMULASI'::character varying, 'IMPORT'::character varying, 'MANUAL'::character varying])::text[]))),
    CONSTRAINT sensor_readings_valid_check CHECK ((valid OR (alasan_invalid IS NOT NULL)))
);


--
-- Name: sensor_readings_2026_08; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_readings_2026_08 (
    id bigint NOT NULL,
    id_meja bigint NOT NULL,
    device_id character varying(32) DEFAULT 'esp32-a'::character varying NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ph numeric(4,2),
    ec_ms_cm numeric(5,3),
    suhu_air_c numeric(4,2),
    suhu_ruangan_c numeric(4,2),
    kelembapan_pct numeric(5,2),
    water_level character varying(20),
    valid boolean DEFAULT true NOT NULL,
    alasan_invalid character varying(60),
    sumber character varying(16) DEFAULT 'ESP32'::character varying NOT NULL,
    CONSTRAINT sensor_readings_ec_check CHECK (((ec_ms_cm IS NULL) OR ((ec_ms_cm >= (0)::numeric) AND (ec_ms_cm <= (10)::numeric)))),
    CONSTRAINT sensor_readings_kelembapan_check CHECK (((kelembapan_pct IS NULL) OR ((kelembapan_pct >= (0)::numeric) AND (kelembapan_pct <= (100)::numeric)))),
    CONSTRAINT sensor_readings_ph_check CHECK (((ph IS NULL) OR ((ph >= (0)::numeric) AND (ph <= (14)::numeric)))),
    CONSTRAINT sensor_readings_suhu_air_check CHECK (((suhu_air_c IS NULL) OR ((suhu_air_c >= ('-10'::integer)::numeric) AND (suhu_air_c <= (80)::numeric)))),
    CONSTRAINT sensor_readings_suhu_ruangan_check CHECK (((suhu_ruangan_c IS NULL) OR ((suhu_ruangan_c >= ('-20'::integer)::numeric) AND (suhu_ruangan_c <= (60)::numeric)))),
    CONSTRAINT sensor_readings_sumber_check CHECK (((sumber)::text = ANY ((ARRAY['ESP32'::character varying, 'SIMULASI'::character varying, 'IMPORT'::character varying, 'MANUAL'::character varying])::text[]))),
    CONSTRAINT sensor_readings_valid_check CHECK ((valid OR (alasan_invalid IS NOT NULL)))
);


--
-- Name: sensor_readings_2026_09; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_readings_2026_09 (
    id bigint NOT NULL,
    id_meja bigint NOT NULL,
    device_id character varying(32) DEFAULT 'esp32-a'::character varying NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ph numeric(4,2),
    ec_ms_cm numeric(5,3),
    suhu_air_c numeric(4,2),
    suhu_ruangan_c numeric(4,2),
    kelembapan_pct numeric(5,2),
    water_level character varying(20),
    valid boolean DEFAULT true NOT NULL,
    alasan_invalid character varying(60),
    sumber character varying(16) DEFAULT 'ESP32'::character varying NOT NULL,
    CONSTRAINT sensor_readings_ec_check CHECK (((ec_ms_cm IS NULL) OR ((ec_ms_cm >= (0)::numeric) AND (ec_ms_cm <= (10)::numeric)))),
    CONSTRAINT sensor_readings_kelembapan_check CHECK (((kelembapan_pct IS NULL) OR ((kelembapan_pct >= (0)::numeric) AND (kelembapan_pct <= (100)::numeric)))),
    CONSTRAINT sensor_readings_ph_check CHECK (((ph IS NULL) OR ((ph >= (0)::numeric) AND (ph <= (14)::numeric)))),
    CONSTRAINT sensor_readings_suhu_air_check CHECK (((suhu_air_c IS NULL) OR ((suhu_air_c >= ('-10'::integer)::numeric) AND (suhu_air_c <= (80)::numeric)))),
    CONSTRAINT sensor_readings_suhu_ruangan_check CHECK (((suhu_ruangan_c IS NULL) OR ((suhu_ruangan_c >= ('-20'::integer)::numeric) AND (suhu_ruangan_c <= (60)::numeric)))),
    CONSTRAINT sensor_readings_sumber_check CHECK (((sumber)::text = ANY ((ARRAY['ESP32'::character varying, 'SIMULASI'::character varying, 'IMPORT'::character varying, 'MANUAL'::character varying])::text[]))),
    CONSTRAINT sensor_readings_valid_check CHECK ((valid OR (alasan_invalid IS NOT NULL)))
);


--
-- Name: sensor_readings_2026_10; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_readings_2026_10 (
    id bigint NOT NULL,
    id_meja bigint NOT NULL,
    device_id character varying(32) DEFAULT 'esp32-a'::character varying NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ph numeric(4,2),
    ec_ms_cm numeric(5,3),
    suhu_air_c numeric(4,2),
    suhu_ruangan_c numeric(4,2),
    kelembapan_pct numeric(5,2),
    water_level character varying(20),
    valid boolean DEFAULT true NOT NULL,
    alasan_invalid character varying(60),
    sumber character varying(16) DEFAULT 'ESP32'::character varying NOT NULL,
    CONSTRAINT sensor_readings_ec_check CHECK (((ec_ms_cm IS NULL) OR ((ec_ms_cm >= (0)::numeric) AND (ec_ms_cm <= (10)::numeric)))),
    CONSTRAINT sensor_readings_kelembapan_check CHECK (((kelembapan_pct IS NULL) OR ((kelembapan_pct >= (0)::numeric) AND (kelembapan_pct <= (100)::numeric)))),
    CONSTRAINT sensor_readings_ph_check CHECK (((ph IS NULL) OR ((ph >= (0)::numeric) AND (ph <= (14)::numeric)))),
    CONSTRAINT sensor_readings_suhu_air_check CHECK (((suhu_air_c IS NULL) OR ((suhu_air_c >= ('-10'::integer)::numeric) AND (suhu_air_c <= (80)::numeric)))),
    CONSTRAINT sensor_readings_suhu_ruangan_check CHECK (((suhu_ruangan_c IS NULL) OR ((suhu_ruangan_c >= ('-20'::integer)::numeric) AND (suhu_ruangan_c <= (60)::numeric)))),
    CONSTRAINT sensor_readings_sumber_check CHECK (((sumber)::text = ANY ((ARRAY['ESP32'::character varying, 'SIMULASI'::character varying, 'IMPORT'::character varying, 'MANUAL'::character varying])::text[]))),
    CONSTRAINT sensor_readings_valid_check CHECK ((valid OR (alasan_invalid IS NOT NULL)))
);


--
-- Name: sensor_readings_2026_11; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_readings_2026_11 (
    id bigint NOT NULL,
    id_meja bigint NOT NULL,
    device_id character varying(32) DEFAULT 'esp32-a'::character varying NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ph numeric(4,2),
    ec_ms_cm numeric(5,3),
    suhu_air_c numeric(4,2),
    suhu_ruangan_c numeric(4,2),
    kelembapan_pct numeric(5,2),
    water_level character varying(20),
    valid boolean DEFAULT true NOT NULL,
    alasan_invalid character varying(60),
    sumber character varying(16) DEFAULT 'ESP32'::character varying NOT NULL,
    CONSTRAINT sensor_readings_ec_check CHECK (((ec_ms_cm IS NULL) OR ((ec_ms_cm >= (0)::numeric) AND (ec_ms_cm <= (10)::numeric)))),
    CONSTRAINT sensor_readings_kelembapan_check CHECK (((kelembapan_pct IS NULL) OR ((kelembapan_pct >= (0)::numeric) AND (kelembapan_pct <= (100)::numeric)))),
    CONSTRAINT sensor_readings_ph_check CHECK (((ph IS NULL) OR ((ph >= (0)::numeric) AND (ph <= (14)::numeric)))),
    CONSTRAINT sensor_readings_suhu_air_check CHECK (((suhu_air_c IS NULL) OR ((suhu_air_c >= ('-10'::integer)::numeric) AND (suhu_air_c <= (80)::numeric)))),
    CONSTRAINT sensor_readings_suhu_ruangan_check CHECK (((suhu_ruangan_c IS NULL) OR ((suhu_ruangan_c >= ('-20'::integer)::numeric) AND (suhu_ruangan_c <= (60)::numeric)))),
    CONSTRAINT sensor_readings_sumber_check CHECK (((sumber)::text = ANY ((ARRAY['ESP32'::character varying, 'SIMULASI'::character varying, 'IMPORT'::character varying, 'MANUAL'::character varying])::text[]))),
    CONSTRAINT sensor_readings_valid_check CHECK ((valid OR (alasan_invalid IS NOT NULL)))
);


--
-- Name: sensor_readings_2026_12; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_readings_2026_12 (
    id bigint NOT NULL,
    id_meja bigint NOT NULL,
    device_id character varying(32) DEFAULT 'esp32-a'::character varying NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ph numeric(4,2),
    ec_ms_cm numeric(5,3),
    suhu_air_c numeric(4,2),
    suhu_ruangan_c numeric(4,2),
    kelembapan_pct numeric(5,2),
    water_level character varying(20),
    valid boolean DEFAULT true NOT NULL,
    alasan_invalid character varying(60),
    sumber character varying(16) DEFAULT 'ESP32'::character varying NOT NULL,
    CONSTRAINT sensor_readings_ec_check CHECK (((ec_ms_cm IS NULL) OR ((ec_ms_cm >= (0)::numeric) AND (ec_ms_cm <= (10)::numeric)))),
    CONSTRAINT sensor_readings_kelembapan_check CHECK (((kelembapan_pct IS NULL) OR ((kelembapan_pct >= (0)::numeric) AND (kelembapan_pct <= (100)::numeric)))),
    CONSTRAINT sensor_readings_ph_check CHECK (((ph IS NULL) OR ((ph >= (0)::numeric) AND (ph <= (14)::numeric)))),
    CONSTRAINT sensor_readings_suhu_air_check CHECK (((suhu_air_c IS NULL) OR ((suhu_air_c >= ('-10'::integer)::numeric) AND (suhu_air_c <= (80)::numeric)))),
    CONSTRAINT sensor_readings_suhu_ruangan_check CHECK (((suhu_ruangan_c IS NULL) OR ((suhu_ruangan_c >= ('-20'::integer)::numeric) AND (suhu_ruangan_c <= (60)::numeric)))),
    CONSTRAINT sensor_readings_sumber_check CHECK (((sumber)::text = ANY ((ARRAY['ESP32'::character varying, 'SIMULASI'::character varying, 'IMPORT'::character varying, 'MANUAL'::character varying])::text[]))),
    CONSTRAINT sensor_readings_valid_check CHECK ((valid OR (alasan_invalid IS NOT NULL)))
);


--
-- Name: sensor_readings_2027_01; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_readings_2027_01 (
    id bigint NOT NULL,
    id_meja bigint NOT NULL,
    device_id character varying(32) DEFAULT 'esp32-a'::character varying NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ph numeric(4,2),
    ec_ms_cm numeric(5,3),
    suhu_air_c numeric(4,2),
    suhu_ruangan_c numeric(4,2),
    kelembapan_pct numeric(5,2),
    water_level character varying(20),
    valid boolean DEFAULT true NOT NULL,
    alasan_invalid character varying(60),
    sumber character varying(16) DEFAULT 'ESP32'::character varying NOT NULL,
    CONSTRAINT sensor_readings_ec_check CHECK (((ec_ms_cm IS NULL) OR ((ec_ms_cm >= (0)::numeric) AND (ec_ms_cm <= (10)::numeric)))),
    CONSTRAINT sensor_readings_kelembapan_check CHECK (((kelembapan_pct IS NULL) OR ((kelembapan_pct >= (0)::numeric) AND (kelembapan_pct <= (100)::numeric)))),
    CONSTRAINT sensor_readings_ph_check CHECK (((ph IS NULL) OR ((ph >= (0)::numeric) AND (ph <= (14)::numeric)))),
    CONSTRAINT sensor_readings_suhu_air_check CHECK (((suhu_air_c IS NULL) OR ((suhu_air_c >= ('-10'::integer)::numeric) AND (suhu_air_c <= (80)::numeric)))),
    CONSTRAINT sensor_readings_suhu_ruangan_check CHECK (((suhu_ruangan_c IS NULL) OR ((suhu_ruangan_c >= ('-20'::integer)::numeric) AND (suhu_ruangan_c <= (60)::numeric)))),
    CONSTRAINT sensor_readings_sumber_check CHECK (((sumber)::text = ANY ((ARRAY['ESP32'::character varying, 'SIMULASI'::character varying, 'IMPORT'::character varying, 'MANUAL'::character varying])::text[]))),
    CONSTRAINT sensor_readings_valid_check CHECK ((valid OR (alasan_invalid IS NOT NULL)))
);


--
-- Name: sensor_readings_2027_02; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_readings_2027_02 (
    id bigint NOT NULL,
    id_meja bigint NOT NULL,
    device_id character varying(32) DEFAULT 'esp32-a'::character varying NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ph numeric(4,2),
    ec_ms_cm numeric(5,3),
    suhu_air_c numeric(4,2),
    suhu_ruangan_c numeric(4,2),
    kelembapan_pct numeric(5,2),
    water_level character varying(20),
    valid boolean DEFAULT true NOT NULL,
    alasan_invalid character varying(60),
    sumber character varying(16) DEFAULT 'ESP32'::character varying NOT NULL,
    CONSTRAINT sensor_readings_ec_check CHECK (((ec_ms_cm IS NULL) OR ((ec_ms_cm >= (0)::numeric) AND (ec_ms_cm <= (10)::numeric)))),
    CONSTRAINT sensor_readings_kelembapan_check CHECK (((kelembapan_pct IS NULL) OR ((kelembapan_pct >= (0)::numeric) AND (kelembapan_pct <= (100)::numeric)))),
    CONSTRAINT sensor_readings_ph_check CHECK (((ph IS NULL) OR ((ph >= (0)::numeric) AND (ph <= (14)::numeric)))),
    CONSTRAINT sensor_readings_suhu_air_check CHECK (((suhu_air_c IS NULL) OR ((suhu_air_c >= ('-10'::integer)::numeric) AND (suhu_air_c <= (80)::numeric)))),
    CONSTRAINT sensor_readings_suhu_ruangan_check CHECK (((suhu_ruangan_c IS NULL) OR ((suhu_ruangan_c >= ('-20'::integer)::numeric) AND (suhu_ruangan_c <= (60)::numeric)))),
    CONSTRAINT sensor_readings_sumber_check CHECK (((sumber)::text = ANY ((ARRAY['ESP32'::character varying, 'SIMULASI'::character varying, 'IMPORT'::character varying, 'MANUAL'::character varying])::text[]))),
    CONSTRAINT sensor_readings_valid_check CHECK ((valid OR (alasan_invalid IS NOT NULL)))
);


--
-- Name: sensor_readings_2027_03; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_readings_2027_03 (
    id bigint NOT NULL,
    id_meja bigint NOT NULL,
    device_id character varying(32) DEFAULT 'esp32-a'::character varying NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ph numeric(4,2),
    ec_ms_cm numeric(5,3),
    suhu_air_c numeric(4,2),
    suhu_ruangan_c numeric(4,2),
    kelembapan_pct numeric(5,2),
    water_level character varying(20),
    valid boolean DEFAULT true NOT NULL,
    alasan_invalid character varying(60),
    sumber character varying(16) DEFAULT 'ESP32'::character varying NOT NULL,
    CONSTRAINT sensor_readings_ec_check CHECK (((ec_ms_cm IS NULL) OR ((ec_ms_cm >= (0)::numeric) AND (ec_ms_cm <= (10)::numeric)))),
    CONSTRAINT sensor_readings_kelembapan_check CHECK (((kelembapan_pct IS NULL) OR ((kelembapan_pct >= (0)::numeric) AND (kelembapan_pct <= (100)::numeric)))),
    CONSTRAINT sensor_readings_ph_check CHECK (((ph IS NULL) OR ((ph >= (0)::numeric) AND (ph <= (14)::numeric)))),
    CONSTRAINT sensor_readings_suhu_air_check CHECK (((suhu_air_c IS NULL) OR ((suhu_air_c >= ('-10'::integer)::numeric) AND (suhu_air_c <= (80)::numeric)))),
    CONSTRAINT sensor_readings_suhu_ruangan_check CHECK (((suhu_ruangan_c IS NULL) OR ((suhu_ruangan_c >= ('-20'::integer)::numeric) AND (suhu_ruangan_c <= (60)::numeric)))),
    CONSTRAINT sensor_readings_sumber_check CHECK (((sumber)::text = ANY ((ARRAY['ESP32'::character varying, 'SIMULASI'::character varying, 'IMPORT'::character varying, 'MANUAL'::character varying])::text[]))),
    CONSTRAINT sensor_readings_valid_check CHECK ((valid OR (alasan_invalid IS NOT NULL)))
);


--
-- Name: sensor_readings_2027_04; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_readings_2027_04 (
    id bigint NOT NULL,
    id_meja bigint NOT NULL,
    device_id character varying(32) DEFAULT 'esp32-a'::character varying NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ph numeric(4,2),
    ec_ms_cm numeric(5,3),
    suhu_air_c numeric(4,2),
    suhu_ruangan_c numeric(4,2),
    kelembapan_pct numeric(5,2),
    water_level character varying(20),
    valid boolean DEFAULT true NOT NULL,
    alasan_invalid character varying(60),
    sumber character varying(16) DEFAULT 'ESP32'::character varying NOT NULL,
    CONSTRAINT sensor_readings_ec_check CHECK (((ec_ms_cm IS NULL) OR ((ec_ms_cm >= (0)::numeric) AND (ec_ms_cm <= (10)::numeric)))),
    CONSTRAINT sensor_readings_kelembapan_check CHECK (((kelembapan_pct IS NULL) OR ((kelembapan_pct >= (0)::numeric) AND (kelembapan_pct <= (100)::numeric)))),
    CONSTRAINT sensor_readings_ph_check CHECK (((ph IS NULL) OR ((ph >= (0)::numeric) AND (ph <= (14)::numeric)))),
    CONSTRAINT sensor_readings_suhu_air_check CHECK (((suhu_air_c IS NULL) OR ((suhu_air_c >= ('-10'::integer)::numeric) AND (suhu_air_c <= (80)::numeric)))),
    CONSTRAINT sensor_readings_suhu_ruangan_check CHECK (((suhu_ruangan_c IS NULL) OR ((suhu_ruangan_c >= ('-20'::integer)::numeric) AND (suhu_ruangan_c <= (60)::numeric)))),
    CONSTRAINT sensor_readings_sumber_check CHECK (((sumber)::text = ANY ((ARRAY['ESP32'::character varying, 'SIMULASI'::character varying, 'IMPORT'::character varying, 'MANUAL'::character varying])::text[]))),
    CONSTRAINT sensor_readings_valid_check CHECK ((valid OR (alasan_invalid IS NOT NULL)))
);


--
-- Name: sensor_readings_2027_05; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_readings_2027_05 (
    id bigint NOT NULL,
    id_meja bigint NOT NULL,
    device_id character varying(32) DEFAULT 'esp32-a'::character varying NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ph numeric(4,2),
    ec_ms_cm numeric(5,3),
    suhu_air_c numeric(4,2),
    suhu_ruangan_c numeric(4,2),
    kelembapan_pct numeric(5,2),
    water_level character varying(20),
    valid boolean DEFAULT true NOT NULL,
    alasan_invalid character varying(60),
    sumber character varying(16) DEFAULT 'ESP32'::character varying NOT NULL,
    CONSTRAINT sensor_readings_ec_check CHECK (((ec_ms_cm IS NULL) OR ((ec_ms_cm >= (0)::numeric) AND (ec_ms_cm <= (10)::numeric)))),
    CONSTRAINT sensor_readings_kelembapan_check CHECK (((kelembapan_pct IS NULL) OR ((kelembapan_pct >= (0)::numeric) AND (kelembapan_pct <= (100)::numeric)))),
    CONSTRAINT sensor_readings_ph_check CHECK (((ph IS NULL) OR ((ph >= (0)::numeric) AND (ph <= (14)::numeric)))),
    CONSTRAINT sensor_readings_suhu_air_check CHECK (((suhu_air_c IS NULL) OR ((suhu_air_c >= ('-10'::integer)::numeric) AND (suhu_air_c <= (80)::numeric)))),
    CONSTRAINT sensor_readings_suhu_ruangan_check CHECK (((suhu_ruangan_c IS NULL) OR ((suhu_ruangan_c >= ('-20'::integer)::numeric) AND (suhu_ruangan_c <= (60)::numeric)))),
    CONSTRAINT sensor_readings_sumber_check CHECK (((sumber)::text = ANY ((ARRAY['ESP32'::character varying, 'SIMULASI'::character varying, 'IMPORT'::character varying, 'MANUAL'::character varying])::text[]))),
    CONSTRAINT sensor_readings_valid_check CHECK ((valid OR (alasan_invalid IS NOT NULL)))
);


--
-- Name: sensor_readings_default; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_readings_default (
    id bigint NOT NULL,
    id_meja bigint NOT NULL,
    device_id character varying(32) DEFAULT 'esp32-a'::character varying NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ph numeric(4,2),
    ec_ms_cm numeric(5,3),
    suhu_air_c numeric(4,2),
    suhu_ruangan_c numeric(4,2),
    kelembapan_pct numeric(5,2),
    water_level character varying(20),
    valid boolean DEFAULT true NOT NULL,
    alasan_invalid character varying(60),
    sumber character varying(16) DEFAULT 'ESP32'::character varying NOT NULL,
    CONSTRAINT sensor_readings_ec_check CHECK (((ec_ms_cm IS NULL) OR ((ec_ms_cm >= (0)::numeric) AND (ec_ms_cm <= (10)::numeric)))),
    CONSTRAINT sensor_readings_kelembapan_check CHECK (((kelembapan_pct IS NULL) OR ((kelembapan_pct >= (0)::numeric) AND (kelembapan_pct <= (100)::numeric)))),
    CONSTRAINT sensor_readings_ph_check CHECK (((ph IS NULL) OR ((ph >= (0)::numeric) AND (ph <= (14)::numeric)))),
    CONSTRAINT sensor_readings_suhu_air_check CHECK (((suhu_air_c IS NULL) OR ((suhu_air_c >= ('-10'::integer)::numeric) AND (suhu_air_c <= (80)::numeric)))),
    CONSTRAINT sensor_readings_suhu_ruangan_check CHECK (((suhu_ruangan_c IS NULL) OR ((suhu_ruangan_c >= ('-20'::integer)::numeric) AND (suhu_ruangan_c <= (60)::numeric)))),
    CONSTRAINT sensor_readings_sumber_check CHECK (((sumber)::text = ANY ((ARRAY['ESP32'::character varying, 'SIMULASI'::character varying, 'IMPORT'::character varying, 'MANUAL'::character varying])::text[]))),
    CONSTRAINT sensor_readings_valid_check CHECK ((valid OR (alasan_invalid IS NOT NULL)))
);


--
-- Name: sensor_readings_hourly; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_readings_hourly (
    id_meja bigint NOT NULL,
    bucket_start timestamp(0) without time zone NOT NULL,
    n_bacaan integer DEFAULT 0 NOT NULL,
    n_valid integer DEFAULT 0 NOT NULL,
    n_override integer DEFAULT 0 NOT NULL,
    ph_avg numeric(4,2),
    ph_min numeric(4,2),
    ph_max numeric(4,2),
    ec_avg numeric(5,3),
    ec_min numeric(5,3),
    ec_max numeric(5,3),
    suhu_air_avg numeric(4,2),
    suhu_air_min numeric(4,2),
    suhu_air_max numeric(4,2),
    suhu_ruangan_avg numeric(4,2),
    kelembapan_avg numeric(5,2),
    dihitung_pada timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: TABLE sensor_readings_hourly; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sensor_readings_hourly IS 'Rollup per jam per meja (rata-rata/min/max/n) — bahan chart & laporan > 24 jam; 120 baris/hari (5 meja) vs 17.280 baris mentah; retensi 2 tahun (±8 MB) — Perancangan FINAL seksi 8 (laporan) + AUDIT_PERFORMA_GARAP.md (query range sargable)';


--
-- Name: COLUMN sensor_readings_hourly.n_override; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sensor_readings_hourly.n_override IS 'Jumlah bacaan dalam jam itu yang mengambil nilai sensor_overrides (bukan nilai sensor)';


--
-- Name: sensor_readings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sensor_readings ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.sensor_readings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sensor_readings_latest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_readings_latest (
    id_meja bigint NOT NULL,
    ph numeric(4,2),
    ec_ms_cm numeric(5,3),
    suhu_air_c numeric(4,2),
    suhu_ruangan_c numeric(4,2),
    kelembapan_pct numeric(5,2),
    water_level character varying(20),
    id_reading bigint,
    sumber_created_at timestamp(0) without time zone,
    id_override_aktif bigint,
    diupdate_pada timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: TABLE sensor_readings_latest; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sensor_readings_latest IS 'Snapshot bacaan terakhir tiap meja (1 baris/meja) — diupsert pada tiap tulis sensor_readings; sumber /api/latest-sensor & /dashboard tanpa scan partisi (audit: cache latest 2 dtk, is_online ≤ 120 dtk)';


--
-- Name: sensor_thresholds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_thresholds (
    id bigint NOT NULL,
    sensor character varying(50) NOT NULL,
    min double precision,
    max double precision,
    updated_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    satuan character varying(20),
    deadband double precision,
    sanity_min double precision,
    sanity_max double precision,
    keterangan text
);


--
-- Name: COLUMN sensor_thresholds.deadband; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sensor_thresholds.deadband IS 'Lebar pita mati — Perancangan FINAL Tabel 13 (EC ±100 ppm, pH ±0,2)';


--
-- Name: COLUMN sensor_thresholds.sanity_min; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sensor_thresholds.sanity_min IS 'Batas bacaan mustahil (dibuang) — Perancangan FINAL seksi 4.1 par.60 / seksi 9 par.209';


--
-- Name: COLUMN sensor_thresholds.sanity_max; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sensor_thresholds.sanity_max IS 'Batas bacaan mustahil (dibuang) — Perancangan FINAL seksi 4.1 par.60 / seksi 9 par.209';


--
-- Name: sensor_thresholds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sensor_thresholds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sensor_thresholds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sensor_thresholds_id_seq OWNED BY public.sensor_thresholds.id;


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id character varying(255) NOT NULL,
    user_id bigint,
    ip_address character varying(45),
    user_agent text,
    payload text NOT NULL,
    last_activity integer NOT NULL
);


--
-- Name: sikluses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sikluses (
    id_siklus bigint NOT NULL,
    id_tanaman bigint,
    nama_siklus character varying(100) NOT NULL,
    waktu_siklus integer NOT NULL,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    expires_at timestamp(0) without time zone
);


--
-- Name: sikluses_id_siklus_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sikluses_id_siklus_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sikluses_id_siklus_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sikluses_id_siklus_seq OWNED BY public.sikluses.id_siklus;


--
-- Name: tanamen; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tanamen (
    id_tanaman bigint NOT NULL,
    nama_tanaman character varying(50) NOT NULL,
    id_meja bigint,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    expires_at timestamp(0) without time zone
);


--
-- Name: tanamen_id_tanaman_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tanamen_id_tanaman_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tanamen_id_tanaman_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tanamen_id_tanaman_seq OWNED BY public.tanamen.id_tanaman;


--
-- Name: target_nutrisi; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.target_nutrisi (
    id bigint NOT NULL,
    id_tanaman bigint,
    tahap character varying(32) NOT NULL,
    umur_min_hari integer,
    umur_max_hari integer,
    ec_min_ppm numeric(8,2),
    ec_max_ppm numeric(8,2),
    ph_min numeric(4,2),
    ph_max numeric(4,2),
    status character varying(24) DEFAULT 'menunggu_konfirmasi'::character varying NOT NULL,
    keterangan text,
    sumber character varying(120),
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT target_nutrisi_rentang_check CHECK ((((ec_min_ppm IS NULL) OR (ec_max_ppm IS NULL) OR (ec_min_ppm <= ec_max_ppm)) AND ((ph_min IS NULL) OR (ph_max IS NULL) OR (ph_min <= ph_max)) AND ((umur_min_hari IS NULL) OR (umur_max_hari IS NULL) OR (umur_min_hari <= umur_max_hari)))),
    CONSTRAINT target_nutrisi_status_check CHECK (((status)::text = ANY ((ARRAY['menunggu_konfirmasi'::character varying, 'aktif'::character varying, 'kadaluarsa'::character varying])::text[])))
);


--
-- Name: TABLE target_nutrisi; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.target_nutrisi IS 'Setpoint EC/pH per jenis tanaman per umur/tahap — Perancangan FINAL Lampiran B par.249 (nilai ditentukan tim website)';


--
-- Name: COLUMN target_nutrisi.id_tanaman; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.target_nutrisi.id_tanaman IS 'NULL = target global untuk semua tanaman; terisi = override per jenis tanaman (daun bawang, selada, pakcoy — seksi 1.1 par.14)';


--
-- Name: COLUMN target_nutrisi.tahap; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.target_nutrisi.tahap IS 'Semai | Peremajaan | Pendewasaan — mengikuti sikluses.nama_siklus di DB (Lampiran B menyebut "per umur/tahap")';


--
-- Name: COLUMN target_nutrisi.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.target_nutrisi.status IS 'menunggu_konfirmasi = nilai masih NULL (Lampiran B); aktif = sudah disetujui tim website; kadaluarsa = diganti versi baru';


--
-- Name: target_nutrisi_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.target_nutrisi ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.target_nutrisi_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: timing_operasi; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.timing_operasi (
    param character varying(64) NOT NULL,
    nilai numeric(10,3),
    satuan character varying(24) NOT NULL,
    keterangan text,
    sumber character varying(120),
    diubah_pada timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: TABLE timing_operasi; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.timing_operasi IS 'Durasi/jeda operasi (mixing, monitoring, bilas, timeout) — Perancangan FINAL seksi 4 + Tabel 12 (Ringkasan Timing Operasi)';


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id bigint NOT NULL,
    username character varying(50) NOT NULL,
    email character varying(100) NOT NULL,
    password character varying(255) NOT NULL,
    level character varying(20) DEFAULT 'user'::character varying NOT NULL,
    remember_token character varying(100),
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    is_demo boolean DEFAULT false NOT NULL,
    CONSTRAINT users_level_check CHECK (((level)::text = ANY ((ARRAY['admin'::character varying, 'user'::character varying, 'petani'::character varying])::text[])))
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: v_bacaan_efektif; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_bacaan_efektif AS
 SELECT r.id_meja,
    r.created_at,
    r.device_id,
    f.field,
    f.nilai_sensor,
        CASE
            WHEN (o.id IS NOT NULL) THEN o.nilai
            ELSE f.nilai_sensor
        END AS nilai_efektif,
    o.id AS id_override,
    o.alasan AS override_alasan,
    r.valid
   FROM ((public.sensor_readings r
     CROSS JOIN LATERAL ( VALUES ('ph'::text,r.ph), ('ec_ms_cm'::text,r.ec_ms_cm), ('suhu_air_c'::text,r.suhu_air_c), ('suhu_ruangan_c'::text,r.suhu_ruangan_c), ('kelembapan_pct'::text,r.kelembapan_pct)) f(field, nilai_sensor))
     LEFT JOIN public.sensor_overrides o ON (((o.id_meja = r.id_meja) AND ((o.field)::text = f.field) AND ((o.status)::text <> 'dibatalkan'::text) AND (o.mulai_pada <= r.created_at) AND (r.created_at < LEAST(COALESCE(o.berakhir_pada, 'infinity'::timestamp without time zone), COALESCE(o.dihentikan_pada, 'infinity'::timestamp without time zone))))));


--
-- Name: VIEW v_bacaan_efektif; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_bacaan_efektif IS 'Bacaan live dgn prioritas: override aktif > sensor (Prioritas 1: sensor_overrides; fallback: sensor_readings). Urutan pemrosesan: sanity (valid) -> override -> deadband/ambang sensor_thresholds';


--
-- Name: v_dosing_harian; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_dosing_harian AS
 SELECT e.id_meja,
    e.hari,
    (count(*))::integer AS kejadian,
    (COALESCE(sum(e.ronde_total), (0)::bigint))::integer AS suntikan,
    COALESCE(sum(e.volume_total_ml), (0)::numeric) AS volume_ml,
    (count(*) FILTER (WHERE ((e.hasil)::text = 'lock'::text)))::integer AS kejadian_lock,
    (max(kd.nilai))::integer AS maks_kejadian,
    max(kv.nilai) AS maks_volume_ml
   FROM ((public.dosing_events e
     LEFT JOIN public.konfigurasi_dosis kd ON (((kd.param)::text = 'maks_kejadian_per_hari'::text)))
     LEFT JOIN public.konfigurasi_dosis kv ON (((kv.param)::text = 'maks_volume_ab_hari_ml'::text)))
  GROUP BY e.id_meja, e.hari;


--
-- Name: VIEW v_dosing_harian; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_dosing_harian IS 'Counter harian per meja TURUNAN dari dosing_events + pagar dari konfigurasi_dosis (8 kejadian/hari, 500 mL/hari — Tabel 13). penampung_states.kejadian_dosis_hari/volume_ab_hari_ml = CACHE yang disinkronkan & direkonsiliasi dari view ini.';


--
-- Name: wa_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wa_settings (
    id bigint NOT NULL,
    aktif boolean DEFAULT false NOT NULL,
    api_key text,
    target character varying(500),
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone
);


--
-- Name: wa_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wa_settings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wa_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wa_settings_id_seq OWNED BY public.wa_settings.id;


--
-- Name: water_controls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.water_controls (
    id bigint NOT NULL,
    command character varying(255) DEFAULT 'AUTO'::character varying NOT NULL,
    mode character varying(255) DEFAULT 'AUTO'::character varying NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    valve_state character varying(255) DEFAULT 'OFF'::character varying NOT NULL,
    CONSTRAINT water_controls_command_check CHECK (((command)::text = ANY ((ARRAY['AUTO'::character varying, 'FORCE_FILL'::character varying, 'FORCE_STOP'::character varying])::text[]))),
    CONSTRAINT water_controls_mode_check CHECK (((mode)::text = ANY ((ARRAY['AUTO'::character varying, 'MANUAL'::character varying])::text[]))),
    CONSTRAINT water_controls_valve_state_check CHECK (((valve_state)::text = ANY ((ARRAY['ON'::character varying, 'OFF'::character varying])::text[])))
);


--
-- Name: water_controls_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.water_controls_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: water_controls_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.water_controls_id_seq OWNED BY public.water_controls.id;


--
-- Name: water_fill_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.water_fill_events (
    id bigint NOT NULL,
    id_meja bigint NOT NULL,
    id_sesi_kontaktor uuid DEFAULT gen_random_uuid() NOT NULL,
    mulai_pada timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    selesai_pada timestamp(0) without time zone,
    durasi_detik integer,
    pemicu character varying(20) NOT NULL,
    dipicu_oleh bigint,
    valve_sebelum character varying(8) NOT NULL,
    valve_sesudah character varying(8) NOT NULL,
    kontaktor_akhir boolean DEFAULT false NOT NULL,
    timeout_menit numeric(5,2) DEFAULT 15 NOT NULL,
    hasil character varying(16) DEFAULT 'berjalan'::character varying NOT NULL,
    alert_terpicu boolean DEFAULT false NOT NULL,
    keterangan text,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT water_fill_events_hasil_check CHECK (((hasil)::text = ANY ((ARRAY['berjalan'::character varying, 'selesai'::character varying, 'timeout'::character varying, 'dibatalkan'::character varying, 'force_stop'::character varying])::text[]))),
    CONSTRAINT water_fill_events_manual_check CHECK ((((pemicu)::text <> ALL ((ARRAY['FORCE_FILL'::character varying, 'FORCE_STOP'::character varying, 'MANUAL'::character varying])::text[])) OR (dipicu_oleh IS NOT NULL))),
    CONSTRAINT water_fill_events_pemicu_check CHECK (((pemicu)::text = ANY ((ARRAY['AUTO_FLOAT'::character varying, 'FORCE_FILL'::character varying, 'FORCE_STOP'::character varying, 'MANUAL'::character varying])::text[]))),
    CONSTRAINT water_fill_events_valve_check CHECK ((((valve_sebelum)::text = ANY ((ARRAY['ON'::character varying, 'OFF'::character varying])::text[])) AND ((valve_sesudah)::text = ANY ((ARRAY['ON'::character varying, 'OFF'::character varying])::text[])))),
    CONSTRAINT water_fill_events_waktu_check CHECK (((selesai_pada IS NULL) OR (selesai_pada >= mulai_pada)))
);


--
-- Name: TABLE water_fill_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.water_fill_events IS 'Log pengisian air bersih per penampung — Aturan 2/3 (prioritas isi air) + Tabel 13 timeout 15 menit; transisi solenoid & contactor dicatat';


--
-- Name: COLUMN water_fill_events.id_sesi_kontaktor; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.water_fill_events.id_sesi_kontaktor IS 'Kelompok jalur yang terisi BERSAMAAN (Aturan 3: dua float turun -> dua solenoid kebuka, contactor ON sekali)';


--
-- Name: COLUMN water_fill_events.pemicu; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.water_fill_events.pemicu IS 'AUTO_FLOAT (pelampung turun) | FORCE_FILL (perintah web) | FORCE_STOP | MANUAL';


--
-- Name: COLUMN water_fill_events.timeout_menit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.water_fill_events.timeout_menit IS 'Snapshot timeout yang berlaku saat kejadian (timing_operasi.isi_air_timeout_menit, default 15)';


--
-- Name: COLUMN water_fill_events.hasil; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.water_fill_events.hasil IS 'timeout = lewat 15 menit float tidak naik -> contactor mati + ALERT (Aturan 3 par.122)';


--
-- Name: water_fill_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.water_fill_events ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.water_fill_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sensor_readings_2026_07; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings ATTACH PARTITION public.sensor_readings_2026_07 FOR VALUES FROM ('2026-07-01 00:00:00') TO ('2026-08-01 00:00:00');


--
-- Name: sensor_readings_2026_08; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings ATTACH PARTITION public.sensor_readings_2026_08 FOR VALUES FROM ('2026-08-01 00:00:00') TO ('2026-09-01 00:00:00');


--
-- Name: sensor_readings_2026_09; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings ATTACH PARTITION public.sensor_readings_2026_09 FOR VALUES FROM ('2026-09-01 00:00:00') TO ('2026-10-01 00:00:00');


--
-- Name: sensor_readings_2026_10; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings ATTACH PARTITION public.sensor_readings_2026_10 FOR VALUES FROM ('2026-10-01 00:00:00') TO ('2026-11-01 00:00:00');


--
-- Name: sensor_readings_2026_11; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings ATTACH PARTITION public.sensor_readings_2026_11 FOR VALUES FROM ('2026-11-01 00:00:00') TO ('2026-12-01 00:00:00');


--
-- Name: sensor_readings_2026_12; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings ATTACH PARTITION public.sensor_readings_2026_12 FOR VALUES FROM ('2026-12-01 00:00:00') TO ('2027-01-01 00:00:00');


--
-- Name: sensor_readings_2027_01; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings ATTACH PARTITION public.sensor_readings_2027_01 FOR VALUES FROM ('2027-01-01 00:00:00') TO ('2027-02-01 00:00:00');


--
-- Name: sensor_readings_2027_02; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings ATTACH PARTITION public.sensor_readings_2027_02 FOR VALUES FROM ('2027-02-01 00:00:00') TO ('2027-03-01 00:00:00');


--
-- Name: sensor_readings_2027_03; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings ATTACH PARTITION public.sensor_readings_2027_03 FOR VALUES FROM ('2027-03-01 00:00:00') TO ('2027-04-01 00:00:00');


--
-- Name: sensor_readings_2027_04; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings ATTACH PARTITION public.sensor_readings_2027_04 FOR VALUES FROM ('2027-04-01 00:00:00') TO ('2027-05-01 00:00:00');


--
-- Name: sensor_readings_2027_05; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings ATTACH PARTITION public.sensor_readings_2027_05 FOR VALUES FROM ('2027-05-01 00:00:00') TO ('2027-06-01 00:00:00');


--
-- Name: sensor_readings_default; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings ATTACH PARTITION public.sensor_readings_default DEFAULT;


--
-- Name: alert_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_logs ALTER COLUMN id SET DEFAULT nextval('public.alert_logs_id_seq'::regclass);


--
-- Name: failed_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.failed_jobs ALTER COLUMN id SET DEFAULT nextval('public.failed_jobs_id_seq'::regclass);


--
-- Name: jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs ALTER COLUMN id SET DEFAULT nextval('public.jobs_id_seq'::regclass);


--
-- Name: mejas id_meja; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mejas ALTER COLUMN id_meja SET DEFAULT nextval('public.mejas_id_meja_seq'::regclass);


--
-- Name: migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations ALTER COLUMN id SET DEFAULT nextval('public.migrations_id_seq'::regclass);


--
-- Name: monitorings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitorings ALTER COLUMN id SET DEFAULT nextval('public.monitorings_id_seq'::regclass);


--
-- Name: panens id_panen; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.panens ALTER COLUMN id_panen SET DEFAULT nextval('public.panens_id_panen_seq'::regclass);


--
-- Name: pendewasaans id_pendewasaan; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pendewasaans ALTER COLUMN id_pendewasaan SET DEFAULT nextval('public.pendewasaans_id_pendewasaan_seq'::regclass);


--
-- Name: peremajaans id_peremajaan; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.peremajaans ALTER COLUMN id_peremajaan SET DEFAULT nextval('public.peremajaans_id_peremajaan_seq'::regclass);


--
-- Name: semais id_semai; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semais ALTER COLUMN id_semai SET DEFAULT nextval('public.semais_id_semai_seq'::regclass);


--
-- Name: sensor_thresholds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_thresholds ALTER COLUMN id SET DEFAULT nextval('public.sensor_thresholds_id_seq'::regclass);


--
-- Name: sikluses id_siklus; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sikluses ALTER COLUMN id_siklus SET DEFAULT nextval('public.sikluses_id_siklus_seq'::regclass);


--
-- Name: tanamen id_tanaman; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tanamen ALTER COLUMN id_tanaman SET DEFAULT nextval('public.tanamen_id_tanaman_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: wa_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_settings ALTER COLUMN id SET DEFAULT nextval('public.wa_settings_id_seq'::regclass);


--
-- Name: water_controls id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.water_controls ALTER COLUMN id SET DEFAULT nextval('public.water_controls_id_seq'::regclass);


--
-- Data for Name: alert_logs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.alert_logs (id, type, value, created_at, updated_at, id_meja, severity, locked, acknowledged, acknowledged_at) FROM stdin;
1	solenoid	ON (uji node)	2026-10-15 06:08:40	2026-10-15 06:08:40	\N	info	f	f	\N
2	solenoid	ON (uji node)	2026-10-15 06:11:32	2026-10-15 06:11:32	\N	info	f	f	\N
3	uji	x0	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
4	uji	x1	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
5	uji	x2	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
6	uji	x3	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
7	uji	x4	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
8	uji	x5	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
9	uji	x6	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
10	uji	x7	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
11	uji	x8	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
12	uji	x9	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
13	uji	x10	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
14	uji	x11	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
15	uji	x12	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
16	uji	x13	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
17	uji	x14	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
18	uji	x15	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
19	uji	x16	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
20	uji	x17	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
21	uji	x18	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
22	uji	x19	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
23	uji	x20	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
24	uji	x21	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
25	uji	x22	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
26	uji	x23	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
27	uji	x24	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
28	uji	x25	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
29	uji	x26	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
30	uji	x27	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
31	uji	x28	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
32	uji	x29	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
33	uji	x30	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
34	uji	x31	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
35	uji	x32	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
36	uji	x33	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
37	uji	x34	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
38	uji	x35	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
39	uji	x36	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
40	uji	x37	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
41	uji	x38	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
42	uji	x39	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
43	uji	x40	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
44	uji	x41	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
45	uji	x42	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
46	uji	x43	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
47	uji	x44	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
48	uji	x45	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
49	uji	x46	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
50	uji	x47	2026-10-15 06:30:03	2026-10-15 06:30:03	\N	info	f	f	\N
51	uji	x	2026-10-15 06:44:51	2026-10-15 06:44:51	\N	info	f	f	\N
\.


--
-- Data for Name: aturan_fail_safe; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.aturan_fail_safe (kode, kondisi, aksi, ambang, satuan, aktif, sumber) FROM stdin;
FS-TIMEOUT-ISI-AIR	Isi air melewati timeout	Contactor mati + ALERT ke HP petani (tandon habis / keran lupa / selang lepas)	15.000	menit	t	Perancangan FINAL Aturan 3 par.122 / seksi 9
FS-TIMEOUT-ISI-BOTOL	Pompa isi botol menyala melewati timeout tetapi float tidak naik	Pompa mati + ALERT (float macet / selang bocor)	60.000	detik	t	Perancangan FINAL seksi 4.1 par.66 / Aturan 4
FS-TIMEOUT-BACA	Bacaan tidak stabil lewat timeout	ALERT sensor, bacaan dibuang	120.000	detik	t	Perancangan FINAL Aturan 4 par.129 / Tabel 13
FS-SENSOR-INVALID-3X	3 kali bacaan invalid berturut-turut	ALERT sensor + LOCK dosing penampung; sirkulasi & isi air tetap jalan	3.000	kali	t	Perancangan FINAL seksi 9 par.210
FS-SANITY-EC	Bacaan EC di luar rentang fisik wajar (0,1-5 mS/cm = 50-2500 ppm)	Bacaan mustahil DIBUANG (sanity check)	\N	\N	t	Perancangan FINAL seksi 4.1 par.60 / seksi 9 par.209
FS-SANITY-PH	Bacaan pH di luar rentang fisik wajar (3-9)	Bacaan mustahil DIBUANG (sanity check)	\N	\N	t	Perancangan FINAL seksi 4.1 par.60 / seksi 9 par.209
FS-SANITY-SUHU-AIR	Bacaan suhu air di luar rentang fisik wajar (5-45 C)	Bacaan mustahil DIBUANG (sanity check)	\N	\N	t	Perancangan FINAL seksi 4.1 par.60 / seksi 9 par.209
FS-LONJAKAN-EC	Lonjakan EC > 0,5 mS/cm antar bacaan berurutan	Baca ulang dulu, JANGAN dosing	0.500	mS/cm	t	Perancangan FINAL seksi 4.1 par.60
FS-JATAH-KEJADIAN	Jatah kejadian dosing harian habis	ALERT + LOCK penampung; reset 00:00	8.000	kejadian/hari	t	Perancangan FINAL seksi 1.6 par.35 / Aturan 9
FS-JATAH-VOLUME	Volume AB mix harian habis (semua suntikan termasuk retry)	ALERT + LOCK penampung; reset 00:00	500.000	mL/hari	t	Perancangan FINAL seksi 1.6 par.35 / Aturan 9
FS-RETRY-HABIS	Retry habis (EC 5x / pH 3x) untuk satu penampung	ALERT + LOCK penampung itu; sampling penampung lain lanjut normal	5.000	kali	t	Perancangan FINAL Aturan 7 par.143-144
FS-EC-TINGGI-LEVEL-AMAN	EC tinggi + level air AMAN, baca ulang tetap tinggi	JANGAN isi, JANGAN dosis → ALERT + LOCK penampung	\N	\N	t	Perancangan FINAL Aturan 5 Tabel 9 / Aturan 9
FS-INFO-DINI	Satu penampung mencapai kejadian dosing berturut dalam sehari	INFO dini ke petani (belum LOCK) — cek kebocoran talang/sensor/kebutuhan tanaman	3.000	kejadian berturut	t	Perancangan FINAL Aturan 9 par.152
FS-BOOT-DEFAULT-OFF	Boot / restart / error	Semua pompa dosing & celup, solenoid & contactor = OFF; sirkulasi & aerator tetap ON	\N	\N	t	Perancangan FINAL Aturan 0 par.102 / seksi 9 par.199
FS-E-STOP	E-STOP ditekan	Daya aktuator dosing & isi air diputus FISIK; sirkulasi & aerator tidak ikut; butuh tombol RESET untuk mulai	\N	\N	t	Perancangan FINAL Aturan 12 par.162-163 / seksi 9 par.208
FS-RESET-LOCK	Tombol RESET ditekan petani	Semua status LOCK dibersihkan, siklus mulai awal; counter harian TIDAK direset	\N	\N	t	Perancangan FINAL Aturan 12 par.164
FS-RESET-HARIAN	Pukul 00:00 (RTC)	Counter dosis & volume harian semua penampung direset; LOCK TIDAK ikut direset	\N	\N	t	Perancangan FINAL Aturan 11 par.159-160
FS-WIFI-MATI	WiFi putus	Alert ditahan di antrian (maks 20) + LCD "WIFI OFF"; kontrol lokal tetap jalan; kirim ulang saat online	20.000	pesan	t	Perancangan FINAL Aturan 14 par.176-178
FS-MODE-PEMELIHARAAN	Mode pemeliharaan aktif (dari aplikasi)	Sampling & dosing dijeda, bacaan tidak dicatat, jatah dibekukan; isi air tetap jalan	\N	\N	t	Perancangan FINAL Aturan 13 par.169-170
FS-DEAD-HEAD	Pompa ON saat jalur tertutup (atau jalur ditutup saat pompa ON)	DILARANG — matikan pompa dulu baru tutup jalan (Aturan 1)	\N	\N	t	Perancangan FINAL Aturan 1 par.112
\.


--
-- Data for Name: audit_logs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.audit_logs (id, terjadi_pada, actor_user_id, actor_tipe, actor_label, aksi, tabel, row_id, before_data, after_data, ip, user_agent, request_id, meta) FROM stdin;
\.


--
-- Data for Name: cache; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cache (key, value, expiration) FROM stdin;
vertonik-smart-farm-cache-demo_purge_lock	i:1;	1792014250
\.


--
-- Data for Name: cache_locks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cache_locks (key, owner, expiration) FROM stdin;
\.


--
-- Data for Name: dosing_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.dosing_events (id, id_meja, hari, mulai_pada, selesai_pada, durasi_detik, pemicu, aktor_tipe, dipicu_oleh, alasan, ronde_total, volume_total_ml, ec_sebelum, ec_sesudah, target_ec, hasil, lock_terpicu, id_alert, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: dosing_rounds; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.dosing_rounds (id, id_kejadian, ronde_ke, jenis, target_delta_ec, volume_ml, durasi_pulse_detik, volume_bilas_ml, mulai_pada, selesai_pada, ec_setelah, retry_ke, hasil, catatan) FROM stdin;
\.


--
-- Data for Name: failed_jobs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.failed_jobs (id, uuid, connection, queue, payload, exception, failed_at) FROM stdin;
\.


--
-- Data for Name: jadwal_perawatan; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.jadwal_perawatan (kode, periode, periode_hari, kegiatan, lama_menit, sumber) FROM stdin;
HARIAN	HARIAN	1	Lihat notifikasi HP; pastikan air penampung cukup; pastikan botol sampel terisi dan float responsif; kuras kerak ringan bila kelihatan	5	Perancangan FINAL seksi 11 Tabel 14
MINGGUAN	MINGGUAN	7	Kalibrasi pH (buffer 4,0 / 6,86); bersihkan probe EC & pH dari kerak; cek pompa bilas & wadah air bersih; cek float isi air	20	Perancangan FINAL seksi 11 Tabel 14
DUA_MINGGU	2 MINGGU	14	Uji takaran peristaltik (timbang 1 pulse) - cocokkan tabel dosis; cek check valve & selang dosing	30	Perancangan FINAL seksi 11 Tabel 14
BULANAN	BULANAN	30	Kalibrasi EC (larutan 1413 µS/cm); bersihkan seluruh selang & manifold; cek baut/klamp; uji tombol E-STOP & RESET	60	Perancangan FINAL seksi 11 Tabel 14
KAPAN_PERLU	KAPAN PERLU	\N	Kalibrasi ulang setelah pindah posisi sensor / ganti probe / mati listrik panjang	\N	Perancangan FINAL seksi 11 Tabel 14
\.


--
-- Data for Name: job_batches; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.job_batches (id, name, total_jobs, pending_jobs, failed_jobs, failed_job_ids, options, cancelled_at, created_at, finished_at) FROM stdin;
\.


--
-- Data for Name: jobs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.jobs (id, queue, payload, attempts, reserved_at, available_at, created_at) FROM stdin;
\.


--
-- Data for Name: kalibrasi_sensor; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.kalibrasi_sensor (sensor, metode, larutan_ref, nilai_ref, satuan, periode_hari_min, periode_hari_max, penyimpanan, hasil_ukur, terakhir_dikalibrasi, keterangan, sumber) FROM stdin;
ph	Kalibrasi 2 titik dengan buffer	Buffer pH 4,0 dan 6,86	\N	pH	7	14	Larutan KCl	\N	\N	Kalibrasi pH tiap 1-2 minggu (probe paling rentan); hasil_ukur = NULL sampai kalibrasi lapangan	Perancangan FINAL seksi 10 par.212 & par.220
ec	Kalibrasi dengan larutan standar	Larutan 1413 µS/cm	1413.000	µS/cm	28	28	Larutan KCl	\N	\N	Kalibrasi EC tiap 4 minggu; hasil_ukur = NULL sampai kalibrasi lapangan	Perancangan FINAL seksi 10 par.212 & par.220
debit_sirkulasi	Ukur pakai ember: liter/menit per meja	\N	\N	L/menit	\N	\N	\N	\N	\N	Konfirmasi tabel 4.4 (laju per meja) — masih "…" di dokumen	Perancangan FINAL seksi 10 par.213 / Lampiran B par.252
durasi_bilas	Stopwatch pompa celup bilas sampai ±300 mL	\N	300.000	mL	\N	\N	\N	\N	\N	Acuan ≥ 2× isi pipa; durasi detik = parameter program	Perancangan FINAL seksi 10 par.214 / seksi 4.2 par.73
waktu_isi_botol	Timer per penampung + timeout penuh yang aman	\N	\N	detik	\N	\N	\N	\N	\N	Timeout awal 60 detik; final = 2× hasil ukur — masih "…" untuk hasil akhir	Perancangan FINAL seksi 10 par.215 / Lampiran B par.252
pulsa_peristaltik	Timbang mL per detik tiap pompa	\N	\N	mL/detik	14	14	\N	\N	\N	Cocokkan dengan tabel dosis (Tabel 4); pengujian 2 mingguan	Perancangan FINAL seksi 10 par.216 / Tabel 14
mixing	Uji TANPA aduk: dosis kecil → sampel tiap 2 menit → EC berhenti berubah	\N	15.000	menit	\N	\N	\N	\N	\N	Konfirmasi (boleh dipangkas) mixing 15 menit seragam	Perancangan FINAL seksi 10 par.217 / seksi 4.4 par.94
bilas_anti_endapan	Dosis A → bilas → cek EC air keluar bilas sebelum B	\N	\N	mS/cm	\N	\N	\N	\N	\N	Harus mendekati air bersih; uji bilas anti-endapan	Perancangan FINAL seksi 10 par.218
\.


--
-- Data for Name: konfigurasi_dosis; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.konfigurasi_dosis (param, nilai, satuan, keterangan, sumber, diubah_pada) FROM stdin;
persen_ronde_dosis	65.0000	%	Dosis per ronde = 65% dari kekurangan; tidak pernah 100% sekaligus	Perancangan FINAL seksi 2.3 par.51	2026-10-19 19:42:37.870862
maks_ppm_per_suntikan	300.0000	ppm	Batas per suntikan (0,6 mS/cm)	Perancangan FINAL seksi 2.3 par.51 / Tabel 13	2026-10-19 19:42:37.870862
maks_ms_per_suntikan	0.6000	mS/cm	Batas per suntikan setara 300 ppm	Perancangan FINAL seksi 2.3 par.51	2026-10-19 19:42:37.870862
maks_ml_per_suntikan	214.0000	mL	Setara 300 ppm / 0,6 mS/cm pada penampung 70 L	Perancangan FINAL seksi 2.3 par.51	2026-10-19 19:42:37.870862
maks_suntikan_per_kejadian	5.0000	suntikan	1 kejadian dosing = sesi sampai 5 suntikan dengan baca ulang	Perancangan FINAL seksi 1.6 par.35 / Tabel 2	2026-10-19 19:42:37.870862
maks_kejadian_per_hari	8.0000	kejadian	Retry TIDAK memotong jatah kejadian; reset pukul 00:00	Perancangan FINAL seksi 1.6 par.35 / Tabel 13	2026-10-19 19:42:37.870862
maks_volume_ab_hari_ml	500.0000	mL/hari	Pagar utama — SEMUA suntikan termasuk retry dihitung	Perancangan FINAL seksi 1.6 par.35 / Tabel 13	2026-10-19 19:42:37.870862
maks_volume_ph_hari_ml	100.0000	mL/hari	pH Up/Down per penampung, reset 00:00	Perancangan FINAL Tabel 13	2026-10-19 19:42:37.870862
maks_retry_ec	5.0000	kali	Retry EC per penampung sebelum ALERT + LOCK	Perancangan FINAL Aturan 7 par.143 / Tabel 13	2026-10-19 19:42:37.870862
maks_retry_ph	3.0000	kali	Retry pH per penampung sebelum ALERT + LOCK	Perancangan FINAL Aturan 6 par.139 / Tabel 13	2026-10-19 19:42:37.870862
deadband_ec_ms	0.1000	mS/cm	Pita mati EC setara 100 ppm	Perancangan FINAL Tabel 13	2026-10-19 19:42:37.870862
faktor_ppm_per_ec	500.0000	ppm per mS/cm	Konversi ppm = EC x 500 (LCD & komunikasi petani)	Perancangan FINAL seksi 1.6 par.38 / 2.2 par.48	2026-10-19 19:42:37.870862
ppm_per_detik_pulsa	4.7000	ppm/detik	Referensi cepat: 1 detik pulsa A+B ≈ +4,7 ppm di 70 L	Perancangan FINAL Tabel 4	2026-10-19 19:42:37.870862
faktor_skala_dosis_dft	1.0714	kali	Penampung DFT 75 L: dosis diskalakan volume (kali 75/70 ≈ +7%)	Perancangan FINAL seksi 2.2 par.46	2026-10-19 19:42:37.870862
peringatan_dini_kejadian	3.0000	kejadian berturut	INFO dini ke petani sebelum jatah habis (belum LOCK)	Perancangan FINAL Aturan 9 par.152	2026-10-19 19:42:37.870862
antrian_alert_maks	20.0000	pesan	Alert ditahan saat WiFi mati, maks 20 pesan + stempel waktu	Perancangan FINAL Aturan 14 par.176	2026-10-19 19:42:37.870862
deadband_ec_ppm	100.0000	ppm	Pita mati EC (±0,1 mS/cm) — masuk deadband = MONITORING	Perancangan FINAL Tabel 13	2026-10-19 19:42:37.870862
k_faktor	196.0000	faktor	K = rata-rata dua uji (201 dan 191), dipakai k=196 mS/cm	Perancangan FINAL seksi 2.2 Tabel 3	2026-10-19 19:42:37.870862
deadband_ph	0.2000	pH	Pita mati pH	Perancangan FINAL Tabel 13	2026-10-19 19:42:37.870862
\.


--
-- Data for Name: mapping_channel_esp32; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.mapping_channel_esp32 (kode, kategori, nama, jumlah_channel, pin_gpio, keterangan, sumber) FROM stdin;
CH-ISI-AIR	kelompok_channel	Isi air	5	\N	4 solenoid + 1 contactor	Perancangan FINAL Lampiran A Tabel 17
CH-SAMPLING	kelompok_channel	Sampling	8	\N	4 pompa celup + 4 solenoid return	Perancangan FINAL Lampiran A Tabel 17
CH-DOSING	kelompok_channel	Dosing	9	\N	4 peristaltik (A, B, pH Up, pH Down) + 4 solenoid cabang + 1 pompa bilas	Perancangan FINAL Lampiran A Tabel 17
CH-SIRKULASI	kelompok_channel	Sirkulasi & aerator	0	\N	Langsung listrik, di luar panel alat & di luar E-STOP	Perancangan FINAL Lampiran A Tabel 17
CH-TOTAL-OUTPUT	kelompok_channel	TOTAL OUTPUT	26	\N	5 + 8 + 9 + 4 indikator = 26 channel terpakai dari 32 (2× MCP23017)	Perancangan FINAL Lampiran A Tabel 17
CH-INDIKATOR	kelompok_channel	Indikator pilot lamp	4	\N	4 pilot lamp RGB (sisa channel MCP23017); hijau/kuning/merah per penampung	Perancangan FINAL Lampiran A Tabel 17
CH-INPUT	kelompok_channel	INPUT	8	\N	4 float isi + 1 float botol + tombol E-STOP & RESET	Perancangan FINAL Lampiran A Tabel 17
PIN-I2C	pin	Bus I2C bersama (MCP23017 #1 & #2, SEN0334, ADS1115, LCD 20×4)	\N	21,22	GPIO 21 = SDA, GPIO 22 = SCL	Perancangan FINAL Lampiran A Tabel 18
PIN-ADC-EC-PH	pin	ADC eksternal ADS1115 untuk sensor EC & pH	\N	I2C	ADC1 bawaan cadangan; hindari ADC2 (bentrok WiFi)	Perancangan FINAL Lampiran A Tabel 18 / par.242
PIN-DS18B20	pin	Sensor suhu air DS18B20	\N	4	GPIO 4 digital, kabel 3 inti + resistor pull-up	Perancangan FINAL Lampiran A Tabel 18
PIN-FLOAT	pin	Float switch (4 isi air + 1 penuh botol)	\N	34-39	GPIO 34-39 input; 1 kabel ground bersama	Perancangan FINAL Lampiran A Tabel 18 / par.243
PIN-TOMBOL	pin	Tombol E-STOP (status) & RESET	\N	18,19	GPIO 18 = E-STOP, GPIO 19 = RESET; pemutus daya E-STOP jalur fisis	Perancangan FINAL Lampiran A Tabel 18
PIN-MCP23017-1	pin	MCP23017 #1 — relay solenoid & contactor	13	I2C	solenoid return 4 + solenoid cabang dosing 4 + solenoid isi 4 + contactor 1 (dari 16 ch)	Perancangan FINAL Lampiran A Tabel 18
PIN-MCP23017-2	pin	MCP23017 #2 — pompa celup sampling, peristaltik, bilas	9	I2C	pompa celup sampling 4 + peristaltik 4 + pompa bilas 1; sisa channel cadangan	Perancangan FINAL Lampiran A Tabel 18
PIN-RELAY-CADANGAN	pin	Relay modul optocoupled total	22	\N	±22 channel dari 3-4 modul relay 8-16 ch (22 output > ±18 pin aman ESP32 → wajib MCP23017)	Perancangan FINAL Lampiran A par.241 / Tabel 15
\.


--
-- Data for Name: mejas; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.mejas (id_meja, meja, jumlah_lubang, created_at, updated_at, expires_at, jenis_talang, kapasitas_penampung_l, jumlah_talang, lubang_per_talang, panjang_talang_m, laju_per_talang_lpm, kenaikan_air_cm) FROM stdin;
8	Peremajaan 1	624	2026-10-14 14:34:33	2026-10-14 14:34:33	\N	\N	\N	\N	\N	\N	\N	40
9	Peremajaan 2	312	2026-10-14 14:34:33	2026-10-14 14:34:33	\N	\N	\N	\N	\N	\N	\N	40
10	Pendewasaan 1	200	2026-10-14 14:34:33	2026-10-14 14:34:33	\N	\N	\N	\N	\N	\N	\N	40
3	Meja Selada	10	2026-10-14 14:34:33	2026-10-20 07:44:33	\N	\N	\N	\N	\N	\N	\N	40
11	Pendewasaan 2	200	2026-10-14 14:34:33	2026-10-14 14:34:33	\N	\N	\N	\N	\N	\N	\N	40
\.


--
-- Data for Name: migrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.migrations (id, migration, batch) FROM stdin;
1	0001_01_01_000000_create_users_table	1
2	0001_01_01_000001_create_cache_table	1
3	0001_01_01_000002_create_jobs_table	1
4	2026_09_09_132730_create_mejas_table	1
5	2026_09_09_132731_create_tanamen_table	1
6	2026_09_09_132732_create_sikluses_table	1
7	2026_09_09_132733_create_semais_table	1
8	2026_09_09_132734_create_peremajaans_table	1
9	2026_09_09_132735_create_pendewasaans_table	1
10	2026_09_09_132736_create_panens_table	1
11	2026_09_09_132737_create_monitorings_table	1
12	2026_09_09_132738_create_alert_logs_table	1
13	2026_09_09_132740_create_sensor_thresholds_table	1
14	2026_09_09_132741_create_water_controls_table	1
15	2026_09_10_010730_add_valve_state_to_water_controls_table	1
16	2026_10_03_031928_add_demo_support	1
17	2026_10_06_000001_tambah_level_petani_users	2
18	2026_10_06_000002_tambah_meja_di_semais	2
19	2026_10_06_000003_pulihkan_check_status_dan_index_rantai	2
20	2026_10_09_000001_tambah_jumlah_masuk_ke_peremajaans_dan_pendewasaans	2
21	2026_10_10_000001_create_wa_settings_table	2
22	2026_10_14_000001_lebarkan_api_key_wa_settings	3
\.


--
-- Data for Name: monitorings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.monitorings (id, "waterTemp", ph, tds, "airTemp", humidity, water_level, created_at, updated_at, id_meja, ec_ms_cm) FROM stdin;
1	26.1	6.4	1180	31.2	68	Sedang	2026-10-15 06:11:32	2026-10-15 06:11:32	\N	\N
2	26.2	6.3	1150	31	67	Sedang	2026-10-15 06:14:20	2026-10-15 06:14:20	\N	\N
3	26	6.4	1180	31	68	Load	2026-10-15 06:31:36	2026-10-15 06:31:36	\N	\N
5	26	6.4	1180	31	68	Load	2026-10-15 06:31:36	2026-10-15 06:31:36	\N	\N
4	26	6.4	1180	31	68	Load	2026-10-15 06:31:36	2026-10-15 06:31:36	\N	\N
6	26.2	6.3	1150	31	67	Sedang	2026-10-15 06:39:20	2026-10-15 06:39:20	\N	\N
7	26.5	6.4	1180	31	68	Sedang	2026-10-15 06:39:56	2026-10-15 06:39:56	\N	\N
8	26	6.4	1180	31	68	Load	2026-10-15 06:39:57	2026-10-15 06:39:57	\N	\N
9	26	6.4	1180	31	68	Load	2026-10-15 06:39:57	2026-10-15 06:39:57	\N	\N
10	26	6.4	1180	31	68	Load	2026-10-15 06:39:57	2026-10-15 06:39:57	\N	\N
11	26	6.4	1180	31	68	Load	2026-10-15 06:39:57	2026-10-15 06:39:57	\N	\N
100012	26.9	6.5	1200	31	66	Sedang	2026-10-15 06:43:58	2026-10-15 06:43:58	\N	\N
100022	25	6.2	\N	\N	\N	\N	2026-10-21 10:21:12	2026-10-21 10:21:12	\N	\N
100027	\N	6.2	\N	\N	\N	\N	2026-10-21 11:45:36	2026-10-21 11:45:36	\N	\N
100028	\N	6.2	\N	\N	\N	YYYYYYYYYYYYYYYYYYY	2026-10-21 11:45:36	2026-10-21 11:45:36	\N	\N
\.


--
-- Data for Name: panens; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.panens (id_panen, id_pendewasaan, panen_berhasil, panen_gagal, tgl_panen, keterangan, created_at, updated_at, expires_at) FROM stdin;
1	1	2	0	2026-05-25	panen perdana	2026-10-14 14:34:33	2026-10-14 14:34:33	\N
2	3	20	3	2026-08-21	panen caipira	2026-10-14 14:34:33	2026-10-14 14:34:33	\N
\.


--
-- Data for Name: password_reset_tokens; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.password_reset_tokens (email, token, created_at) FROM stdin;
\.


--
-- Data for Name: penampung_states; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.penampung_states (id_meja, status_lock, lock_alasan, lock_sejak, mode_pemeliharaan, kejadian_dosis_hari, volume_ab_hari_ml, volume_ph_hari_ml, target_ec_ppm, target_ph, reset_harian_pada, updated_at) FROM stdin;
8	f	\N	\N	f	0	0.00	0.00	\N	\N	\N	2026-10-19 19:42:37.791875
9	f	\N	\N	f	0	0.00	0.00	\N	\N	\N	2026-10-19 19:42:37.791875
10	f	\N	\N	f	0	0.00	0.00	\N	\N	\N	2026-10-19 19:42:37.791875
3	f	\N	\N	f	0	0.00	0.00	\N	\N	\N	2026-10-19 19:42:37.791875
11	f	\N	\N	f	0	0.00	0.00	\N	\N	\N	2026-10-19 19:42:37.791875
\.


--
-- Data for Name: pendewasaans; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.pendewasaans (id_pendewasaan, id_peremajaan, id_meja, tanaman_berhasil, tanaman_gagal, tgl_awal_pendewasaan, tgl_akhir_pendewasaan, keterangan, created_at, updated_at, expires_at, jumlah_masuk) FROM stdin;
1	1	3	4	1	2026-05-16	2026-05-24	ada	2026-10-14 14:34:33	2026-10-14 14:34:33	\N	\N
2	1	3	5	5	2026-06-03	2026-06-10	ada	2026-10-14 14:34:33	2026-10-14 14:34:33	\N	\N
3	4	9	23	23	2026-08-12	2026-08-20	wewe	2026-10-14 14:34:33	2026-10-14 14:34:33	\N	\N
\.


--
-- Data for Name: peremajaans; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.peremajaans (id_peremajaan, id_semai, id_meja, benih_berhasil, benih_gagal, tgl_awal_peremajaan, tgl_akhir_peremajaan, keterangan, created_at, updated_at, expires_at, jumlah_masuk) FROM stdin;
1	15	3	15	5	2026-05-08	2026-05-15	ada	2026-10-14 14:34:33	2026-10-14 14:34:33	\N	\N
2	15	3	5	5	2026-05-18	2026-05-25	T	2026-10-14 14:34:33	2026-10-14 14:34:33	\N	\N
3	15	8	9	10	2026-08-19	2026-08-26	benih caipira	2026-10-14 14:34:33	2026-10-14 14:34:33	\N	\N
4	15	8	46	23	2026-08-04	2026-08-11	wee	2026-10-14 14:34:33	2026-10-14 14:34:33	\N	\N
\.


--
-- Data for Name: report_logs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.report_logs (id, jenis, judul, periode_dari, periode_sampai, filter, format, status, dibuat_oleh, aktor_tipe, dimulai_pada, selesai_pada, durasi_ms, jumlah_baris, file_path, file_size_bytes, file_sha256, hasil_json, error_message, ip, created_at) FROM stdin;
\.


--
-- Data for Name: semais; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.semais (id_semai, id_tanaman, id_siklus, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, keterangan, benih_berhasil, benih_gagal, created_at, updated_at, expires_at, id_meja) FROM stdin;
15	3	3	200	2026-05-02	2026-05-07	selesai	ada	150	50	2026-10-14 14:34:33	2026-10-14 14:34:33	\N	\N
16	3	3	1000	2026-05-19	2026-05-24	selesai		800	200	2026-10-14 14:34:33	2026-10-14 14:34:33	\N	\N
\.


--
-- Data for Name: sensor_overrides; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sensor_overrides (id, id_meja, field, nilai, satuan, alasan, status, mulai_pada, berakhir_pada, durasi_rencana_menit, dibuat_oleh, dipicu_dari, dihentikan_pada, dihentikan_oleh, alasan_penutup, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: sensor_readings_2026_07; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sensor_readings_2026_07 (id, id_meja, device_id, created_at, ph, ec_ms_cm, suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level, valid, alasan_invalid, sumber) FROM stdin;
\.


--
-- Data for Name: sensor_readings_2026_08; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sensor_readings_2026_08 (id, id_meja, device_id, created_at, ph, ec_ms_cm, suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level, valid, alasan_invalid, sumber) FROM stdin;
\.


--
-- Data for Name: sensor_readings_2026_09; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sensor_readings_2026_09 (id, id_meja, device_id, created_at, ph, ec_ms_cm, suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level, valid, alasan_invalid, sumber) FROM stdin;
\.


--
-- Data for Name: sensor_readings_2026_10; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sensor_readings_2026_10 (id, id_meja, device_id, created_at, ph, ec_ms_cm, suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level, valid, alasan_invalid, sumber) FROM stdin;
\.


--
-- Data for Name: sensor_readings_2026_11; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sensor_readings_2026_11 (id, id_meja, device_id, created_at, ph, ec_ms_cm, suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level, valid, alasan_invalid, sumber) FROM stdin;
\.


--
-- Data for Name: sensor_readings_2026_12; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sensor_readings_2026_12 (id, id_meja, device_id, created_at, ph, ec_ms_cm, suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level, valid, alasan_invalid, sumber) FROM stdin;
\.


--
-- Data for Name: sensor_readings_2027_01; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sensor_readings_2027_01 (id, id_meja, device_id, created_at, ph, ec_ms_cm, suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level, valid, alasan_invalid, sumber) FROM stdin;
\.


--
-- Data for Name: sensor_readings_2027_02; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sensor_readings_2027_02 (id, id_meja, device_id, created_at, ph, ec_ms_cm, suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level, valid, alasan_invalid, sumber) FROM stdin;
\.


--
-- Data for Name: sensor_readings_2027_03; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sensor_readings_2027_03 (id, id_meja, device_id, created_at, ph, ec_ms_cm, suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level, valid, alasan_invalid, sumber) FROM stdin;
\.


--
-- Data for Name: sensor_readings_2027_04; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sensor_readings_2027_04 (id, id_meja, device_id, created_at, ph, ec_ms_cm, suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level, valid, alasan_invalid, sumber) FROM stdin;
\.


--
-- Data for Name: sensor_readings_2027_05; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sensor_readings_2027_05 (id, id_meja, device_id, created_at, ph, ec_ms_cm, suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level, valid, alasan_invalid, sumber) FROM stdin;
\.


--
-- Data for Name: sensor_readings_default; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sensor_readings_default (id, id_meja, device_id, created_at, ph, ec_ms_cm, suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level, valid, alasan_invalid, sumber) FROM stdin;
\.


--
-- Data for Name: sensor_readings_hourly; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sensor_readings_hourly (id_meja, bucket_start, n_bacaan, n_valid, n_override, ph_avg, ph_min, ph_max, ec_avg, ec_min, ec_max, suhu_air_avg, suhu_air_min, suhu_air_max, suhu_ruangan_avg, kelembapan_avg, dihitung_pada) FROM stdin;
\.


--
-- Data for Name: sensor_readings_latest; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sensor_readings_latest (id_meja, ph, ec_ms_cm, suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level, id_reading, sumber_created_at, id_override_aktif, diupdate_pada) FROM stdin;
\.


--
-- Data for Name: sensor_thresholds; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sensor_thresholds (id, sensor, min, max, updated_at, satuan, deadband, sanity_min, sanity_max, keterangan) FROM stdin;
2	ph	5	7	2026-10-14 22:34:33	pH	0.2	3	9	Batas aman pH 5,0-7,0 (Tabel 13); sanity pH 3-9 (seksi 9 par.209)
1	waterTemp	5	40	2026-10-14 22:34:33	C	\N	5	45	Batas aman suhu air 18-30 C (Tabel 13); sanity 5-45 C (seksi 9 par.209)
4	airTemp	20	40	2026-10-14 22:34:33	C	\N	\N	\N	Batas aman suhu udara 15-33 C (Tabel 13) — min/max live masih 20-40, menunggu keputusan user
5	humidity	50	90	2026-10-14 22:34:33	%	\N	\N	\N	Batas aman kelembaban 50-85 % (Tabel 13) — max live masih 90, menunggu keputusan user
3	tds	50	1000	2026-10-20 00:24:01	ppm	100	50	2500	Batas aman default 400-1.250 ppm MENUNGGU riset petani+tim web (Lampiran B par.251); sanity 50-2500 ppm = EC 0,1-5 mS/cm x 500
\.


--
-- Data for Name: sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sessions (id, user_id, ip_address, user_agent, payload, last_activity) FROM stdin;
psXWG1EqCgoHV00B9EzlEjS4mcppnYWa1f80pFUI	\N	127.0.0.1	curl/8.7.1	eyJfdG9rZW4iOiJ6dVFXR3E3c0Vpc3FpRnRqc2dUdVc2cWxlUDFXdDBldmJUQlExOGJJIiwiX3ByZXZpb3VzIjp7InVybCI6Imh0dHA6XC9cLzEyNy4wLjAuMTo4MDAwXC9sb2dpbiIsInJvdXRlIjpudWxsfSwiX2ZsYXNoIjp7Im9sZCI6W10sIm5ldyI6W119fQ==	1791988485
IZk2v2UrLvX3nwMLYgJ4OuZCVBJ6GGuE5hMIRpzk	1	127.0.0.1	Python-urllib/3.14	eyJfdG9rZW4iOiJaOHlsVXBVV21heDlwdVd5NDZRSTNIMldIVFJuSXRIU1hCRnVva1VQIiwiX3ByZXZpb3VzIjp7InVybCI6Imh0dHA6XC9cLzEyNy4wLjAuMTo4MDAwXC9kYXNoYm9hcmQiLCJyb3V0ZSI6ImRhc2hib2FyZCJ9LCJfZmxhc2giOnsib2xkIjpbXSwibmV3IjpbXX0sImxvZ2luX3dlYl81OWJhMzZhZGRjMmIyZjk0MDE1ODBmMDE0YzdmNThlYTRlMzA5ODlkIjoxfQ==	1791988510
lOss0cHL0BQnOAbs3aOdyhOSDSfzgr4STTk1MhSi	\N	127.0.0.1	Python-urllib/3.14	eyJfdG9rZW4iOiI4MGxIZGdEdGhCSjA1UnNLNjZHeG1WWlFmMVpVQkNJNFdSM3VUaTk2IiwiX3ByZXZpb3VzIjp7InVybCI6Imh0dHA6XC9cLzEyNy4wLjAuMTo4MDAwXC9sb2dpbiIsInJvdXRlIjpudWxsfSwiX2ZsYXNoIjp7Im9sZCI6W10sIm5ldyI6W119fQ==	1791989304
aZW6bvbO02Io3ozpvN7zwLYgoUNfHQAbcPFAAooh	\N	127.0.0.1	curl/8.7.1	eyJfdG9rZW4iOiIwQjljWFhNQUxYMXhpNnJKeUR5WDhCR1lkcmdIcUZQaWxHdXNLdFpiIiwiX3ByZXZpb3VzIjp7InVybCI6Imh0dHA6XC9cLzEyNy4wLjAuMTo4MDAwXC9sb2dpbiIsInJvdXRlIjpudWxsfSwiX2ZsYXNoIjp7Im9sZCI6W10sIm5ldyI6W119fQ==	1791989337
E8eS8h4P0YuHzoLs909NVC31SrBvenqV0KDWTedg	\N	127.0.0.1	curl/8.7.1	eyJfdG9rZW4iOiJFOW0zRnpNb1dXRFlWSjZmUzFvNDEyVzRFZ09SZE0zUXQ3b1F4dVc0IiwiX3ByZXZpb3VzIjp7InVybCI6Imh0dHA6XC9cLzEyNy4wLjAuMTo4MDAwXC9sb2dpbiIsInJvdXRlIjpudWxsfSwiX2ZsYXNoIjp7Im9sZCI6W10sIm5ldyI6W119fQ==	1791989337
wUc9RcyambRkGhQX8mowWxahzksPeaDrmXZweENp	\N	127.0.0.1	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Hermes/0.0.0 Chrome/144.0.7559.236 Electron/40.10.2 Safari/537.36	ZXlKcGRpSTZJa1pVZFdSdVJVTk5hMkl6ZGxrdkszaHpjMHQyUm1jOVBTSXNJblpoYkhWbElqb2lVR1JpTUcxaVFYTnJjVU0zYlZJMFYwOXdjbkYxYzJwRVpWQnJOalJDUzBoelptdFlabkl5Um05RU1Xa3lZaXRZZG1OclkyWTNTVTFzVXpWWFQxTXlaRXd6UjFsTFIwZDVjVXhHTVdkQlQwOVNNMDFIYkc5aVUwZG9OVVV6U0V4YVRHWmpaa3RKU2pCU1EzQkdhMDlYUjJjNVIxSmhhbVExTkZOTk5EZEVWbE51WTNwT1EwWm1TSGMzYkZCVFJISTBRWEpFVkZaa1VYUTRiVXRwVWpRcmVHMVhZak5WZVdvemRYSTNXRUpuTUcxa1prYzRSbU5sV1Vodkx6QjFja0ZhVkhseGNXSkNkV0pOUVVnd2RGWTRORTF5Y3pCVmF6ZHBjSEI1U0RsWFoyZFFiMGd3V1dkblExY3hVM0ZKT0haNVdXSndhVTFhTjNrd1drZEhUbkZQVmtOQk5GbFRRWE5yVm14elVHbHdlVWgzUmpORVVuaFZPVmRTVURGbE1tVkdjMnhHVDFGTFRuSlJjSGM5SWl3aWJXRmpJam9pWVRRMU1qUTVNVE0zT1RCbFpqVTFZakUxTnpnM09ERXdPVGt6TnpaaE5EVXdOVFF5WXpkaE5tSmhPRFJoWm1JNE56VTNOVGt3TXpBMU1tWXdPRFU1TnlJc0luUmhaeUk2SWlKOQ==	1791989654
cFZlGYqjPZYADJyNzPkbelCezwdd8VdRMNRHlC8B	\N	127.0.0.1	Python-urllib/3.14	ZXlKcGRpSTZJbFpZVDNnM2FVUmlaM0pJYmxkTmEwNTJZVWhZUjBFOVBTSXNJblpoYkhWbElqb2lORzVMVVc5VGFXZ3JMMWhHY2xWQ2VVSlVTRXBxZDNGNkszVmxNMWx1TkU0MlRISkZMeXM0VlNzNGFUSlhOMFZTZG5SbFZYVmtTSEZCYWs1amFUWjFTemx6VEdFM01rTTVia1ZqYVhkMVRuWnRjRFEyUTNsaVR6UkphVXMyVG1KaVNGWTFjV2x1Vm5Cd1JXRTRjamhyWkhCdk5tZ3hVR2M1VVdWakwyaG5TRkZYVkUxWk9XSlhZbVkxTW5FeE4zUjRiMlkyT0ZSMVV6Wk9OVTlST0hab01IUlVVbkJOYjFCbVkwVllNMkpvTVRkMFZqRTNVazlsWjA1VGQydFRRVXN4ZEhCVFNVWkdhbmRwWldvNGVHaFJkVUZsUkZGTVFUMDlJaXdpYldGaklqb2lPV0l4TmpZMk5USTNaams1TXpRM01UZ3daVEV3TkdZME16QTNZakE1WkRWa05Ua3hNR1psWlRjeE1qRmtabU16TjJaaU5qSTBNamt4WlRZeU9HVmhaU0lzSW5SaFp5STZJaUo5	1792012665
33l5ItDfnfUUPHDLAU61pL7KJHtpuf35V0PSTuou	\N	127.0.0.1	Python-urllib/3.14	ZXlKcGRpSTZJa056ZFd3NU1sRnVTR3RPU0VGblFrRkhWeTlwZEZFOVBTSXNJblpoYkhWbElqb2lUWGQxZFRkUk5FRlVibkJOYzFSdE1GVjJVSE5zVnl0cFNGVjVhbmhuVGtwWVdXd3ZjRzlpU1RFMFNFWkRWelpLVFRGVFdqbFNVRmR5U20xSE9XZFRkSEZ6YjFSeFFVYzVRMFphVlRCa2JXdEhNaXRWV21wa1UxRTNVa2d3ZG0wcmVHTTBTbEZPUldJMk9FTlNlWEZ0ZDI5dmNVdFZkV1ZYWjA1dk1XSXdRelk0TDJzd2FtTTJZVkpPVFROYU5HTnlZVGhPVTNJNFNUWjZla0Z1WWt4RWNHeEpVbFJCY2pCRVoxWmFkell2VWtsNVlXdENlSEl2UzFaMGVDdFFjbEZ4UjBwRVVGb3JSVWRMZEd0RmJrRjRRVlJaVTJjNEwzaGtLemN5VFdnNE16RlBTV3BFTlhaWlpWWmFVR3h4V0cwNGIyWXhOU3M1VDBaRk5FVlhTRU5YTDI0MlptUTBkMVp5Y2tKNU1URk9iM1JtZWtGRVNHZHphWE5RZW10RlpqVmpTemxOSzA1dk5FcERibnB2V0haV09XcDZPSFUxV1ZGWE0zaGFSelV5Y2paVWFVUkZSWE5CZFc5ck5HTmpOVVk0TUU5bFJqUkhZMmhyTDFOWlJYWmFPRkZGSzNCb2NtcFpWVWxXUlVaWVVIaFhLMlkwTDJRM01GTkJTWHB1YzFSNmVuRm1SMGMzUmxwSmQyeHhkemR4TWxGU016VjBTMjVJY0RsSFpGWjVTMWR6U0hkTVQzZEhlVUZxV1ZKcWNYWkZiVFp2ZWtKRWRpOXRTMEkyVTB4RE1TSXNJbTFoWXlJNklqazVNV1F3TVRCa1lUTmpNamt6WVRkak5EQmpNV0prTm1KbU1qYzRNekpoWW1ZNFpUWmlaVEk1TlRkak0yWTFaakJoT1dVNU1XSmlPVEkzTmpabE1qZ2lMQ0owWVdjaU9pSWlmUT09	1792012666
8kXJpTUsuKSXiArZxsyp6fXOIybggUmugEmN4GyC	\N	127.0.0.1	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Hermes/0.0.0 Chrome/144.0.7559.236 Electron/40.10.2 Safari/537.36	ZXlKcGRpSTZJaXREUjJSaGMybFBMMkZsVG5WRlpXVnZkMGszWWtFOVBTSXNJblpoYkhWbElqb2lZa0ZqYjI4eGRTdERSV1I0VVdScGFtMHlSVGhyVEZKU1kydzVhMU01ZEVWd1ZITlJTVTlaZFVNelYyOU1Sa2N4VFZKQ1oxZEtRbUYwVm01SVVtRlRWMUZQZW5KRmREQnNXRXM1U0hwb1NGTXljVVZSVWxGV2VrdExNbUZLZFZaTlJuWjZVbk5FYTFZMlFqQkhSV2NySzBOWFNsZGthMmQ0UVVnM1FtdFpZMFV6U2tGMlMzRXZUMGM0Y2tGbVEzRkZTVlJwU0RKR0sybE9RazVhVlhocGIweDNkeTk0YUV0WWJ6VmtVM0JXTTJoa1VGVlplVU13Vm1Gd1p6Y3daVXRxZW5oSE9XVndXSFZCWldGTU1WUlNUVGhMUkZaWmR6MDlJaXdpYldGaklqb2lZMkptWVdJNFl6VXdOVFV3WVRBeFlXUTVNVEZsTURNeE9UWTBZemxtWWpJNE5qTTFaVGcyWTJFek0yUTRZbVJpTW1Zd1pERTJabVl3WkRoaE16a3hZaUlzSW5SaFp5STZJaUo5	1792015375
j0HSPb5zLKfSl7AcUQGSBMFsygLK6XFkp6VVV5eq	1	127.0.0.1	Python-urllib/3.14	ZXlKcGRpSTZJbUUxT1N0WU1IZFRSMDFHUkZKcVduQnNhSFJYU21jOVBTSXNJblpoYkhWbElqb2labU5QVDFCNU1VaE5iemtyYW5nM05WQTFkbFV2Um5FeFducDBaWFpxVldOemMyUkhSblJEZHpoRU1qSXZRV0ZMTVdWcmFWVnRZelpWWkhvd2RGWk5NVEV6U25ONFJqWnBXa00zVFZFek0zbGhUVVJHTjNjM1dHWTBhMWxpVGpoeFlUaGlkVmRoWjJaWlJIaGxWWFZ4UVd4bWFrbG5ZMGxYUVdRdlMyUnVjR3htUTBveVVHMHZXSGt3ZFRGd2NYcDBNRVZGVlhvNFRuSldNSGhPVWtSM04wOUNiV3N6YzJGT05VcHpka3B2YkZrek1IQllhakZJVWtWVlFUUm5TbGhwZVRKVmJXWkJUeTkxZUc5MVIyeFRUWEI0WlVnMFVHbG1aM3A0SzBoNk5WVjJPRU5RZGtweU1uSXllbGhJZGpFck0xQlpOaTlPY0dNNGQwUTFLMVZTWXk5WmQwWTFSWEI1Tmtaa1YyaENlRXB4Y2l0RlUweFhaRmRQWVc1V05TczVjMVU0TlRKRWNrNUZUSE05SWl3aWJXRmpJam9pT0RZNFpEbGlaR1JqTkdZd1lXRmhNR1F6WmpFNFptUTJNR0ZqTURnNFpEZzJZelE0TUdOa1pXTTVaVFEyTkRZd1l6VTVabVExWTJSbVkySXdaV0kzWmlJc0luUmhaeUk2SWlKOQ==	1792013313
70yTelzqOhABBpAYzY6ea5fxzMltoeTGH9rTvppc	\N	127.0.0.1	Python-urllib/3.14	ZXlKcGRpSTZJbm8yZDFONVprZFdVR1pJUldwRmJtcDJObGRETUdjOVBTSXNJblpoYkhWbElqb2llRzlLVEZOaFVtMVhMMU42YWtwVWMydFhSME14ZWpoSVMzbHBORmxoVVRaTUx6TjVlRTFtWm5CMVZGZFFkbFJXT0dwUE56SlBOak5qV0cxb1dWZE9hRTVyVDJ4R1kwTXJOelZuTDNKdFkyMUJhSGMxYWtGd1NrSllPWEJxVUVGSFVFeEliVUpYV21wUVdFSktVa05uTTJKU2JGRkVPR3RSU0haalVFUlpjblZwWm5remJraE9UV0ZYWm1SclRrTlNSamhTVnpWbFFXSXZVbVJMTTFselVIUlJMMFE1UzFoVVNIaGFXV2gwT1c0MWNqVlViRkZuY2tGaU1uVXlabWxNUlU5M1lUTlJXVWhsYVVvd1IyUnFaWGRvY1V0eVp6MDlJaXdpYldGaklqb2lZemhrTnpBME1tTXlNVGd3TlRVMllXTXpNalk0Wm1NNE1qQTNaR1JoTlRBeFpXUmpZalZpTURRMlpHSXdNekpoTnpZMk5UbGlaakptT0dJeU9HUmhaU0lzSW5SaFp5STZJaUo5	1792013314
WazaQCgUsqIw0IRXzyowww0arXJP2lipgSAwzFak	\N	127.0.0.1	Symfony	ZXlKcGRpSTZJbXgyUms4d1pqRlJNMVZOSzNoQmRHOXBlV3A0VDNjOVBTSXNJblpoYkhWbElqb2lORmxWVmtod1FuUnVhSGhwZUdkV05rRnNTbVJ6YnpsWFdqbERPWFZwTVRneE5UTmhSRmxRZEVKQmVVaFZValpOY21zdmVFSmtZMU5sYUhoM2JGWTBRV1kyTkV0aFFsZzNiVU5rVkZod2JUSktRa0ZzZEd4MGRXTmpUa1JTVURGTFVtZHBSbHBXVTNGWFNrNU1RblZuY25aTk0wazRRbU1yY1hoWGFXNW5aREE0TURWQmIwUnNNR3RPYXpCMVJGaFBjbmRKZDFoU1VURXdXREYyVVRKdWR6WmhRMmRwUTNwT05IVldkRFZzTlcxSFpHaFZSVTkyY0doMmVVRjFVRkZTSzNCdmFXaFBORWxJYkdkemNpdG5hSGRXYjFCSlFUMDlJaXdpYldGaklqb2lPRFppTlRVelpXRXdOelkwWXpCbE5tRmhaRGhrWkdFeU0yRTVOR1F3TWpObVpqUXdaak5pWlRrMVpERTFNVGhqTjJRek9XRmtOVFEzTW1FME1URXlOU0lzSW5SaFp5STZJaUo5	1792013898
z9s4NhIfF2SLhIxDVi5hbQfJD4keFmx1okOtx7uW	1	127.0.0.1	Python-urllib/3.14	ZXlKcGRpSTZJalIzUnpOT1ZrTkJUa3BMWkM5NWVtZGxaVVptYjFFOVBTSXNJblpoYkhWbElqb2lSV2RDUjNZNU0weEpZMUExWm5KVVRXcEViR1JUUTNKMldEQlJlV0ZSTTFad2NVdFdZbloyZDNaeFIwOVpXRGhUVlVKb0wwUmpNMU5JWTA4elVtcGplaloxY2xWblNEbFBSa1ZDVjBZNVIxbFhNM2wwYUhOakx5OVRTSHBVTDBGUkwyUjVSRVJrVUV4aE0xSmhVa3RvU21JcldUZElXbmR3YkdKcU1FZFBUMHgyT1RrMVpYVlpTMWR6VDA5S2FFdzVVWE00T0RFeWVsWlJNelZpYURGS2FtVnBaSEp4YzJWRlZYTXhNakl2U0RscFJYWkJWM1I1Wnk5UmVVRjVPV1F3T1RSNWJrTlFaa1JLZEZWWlRrUkZPVE5qYmtGYVYyZFVOVTQ0UkhCNk4yWkJVbmxQWTAxblJrcE9OM0UwTWxkak4waHlSRzVqU1c5Sk4yWmtUMmhaYW0xWlFrTkdOSEZpU2tkb1J6VnJlRFo1VVhGdWFWVkljbmxhVFVSMGVERkZUbHB2VlZOVlQyeERXa2s5SWl3aWJXRmpJam9pTkdVM1ltUXdPRE0wWVRNMk9UQmhaV00wTm1KbU1qSTRPR0UyWmpWaE0yTTFZMkU1WmpkbFkyUTNORFExTW1NMU1ERmpZakZrWmpsaE1URTJNakU0T0NJc0luUmhaeUk2SWlKOQ==	1792014115
phAcOgKkyNpnroHIF8YFN2sTDygqfIXiB2rNKk4t	1	127.0.0.1	Python-urllib/3.14	ZXlKcGRpSTZJaTluV0hoWVVDdEdhRUV3Um1ReVdWVlJVWFZuYTFFOVBTSXNJblpoYkhWbElqb2lXRFZCWVhSR1IxbFhSWGhOU1ZwR1ZXNTZiRmRFU2xCM2NqUkdWVlo1YW1KNmVHRmxRVXdyUjFka1ZXTm5UazVGZFhOMVMwaHFPV051VUhoNU1sTktNRGxsVTNrNFJsZ3pWWGRRYlhScU9IaFhWREJ6VUdkR09XVnRhUzgxZDFaSlRrZHZibGMzVERSTGFFRjRPVnBIYWxac2RUVlRhMmM1VkdGNk9TdFhla1ExYWxodmVrNVlaelV2YzBrMVduVmtWeXN2UVRCckt6Qm5UR05qT0ROd2FUWkRiakZOWlVsRU0zTmhZblZRVW1FNWRWVkpSQzlUTUc1elRFVmhVRFVyZGtKamJHSk5hVEUxYldZMVExSnhlVGREUmxsbUsyUmpXbGx0YkVGRFRVcGxhV0ZQVjI4M1IyVlVSWEF2V1RGck0wVk5NUzg0UW1kM1lXcGFWRlZ5Ykd4bldIcFJaekZSTldKVWFXbFZNRmM0UTA1YVF6QlNiazUwYkRSRFMxVXJNVTlZYjFNeFlVZzFSMlZoTUU1dlpHWnFWbHBDVjBReVZVTlNVbkpGV2t3aUxDSnRZV01pT2lKaE56STVNVFE0T0RNek5EQTRPV1l5T1dZNFpEa3hNbVF3TkRoa1l6YzJaREJpTjJOaE9URm1OR0prTjJZNE9URXdNR1E0TVdWaFpqbGpOelptTlRVeklpd2lkR0ZuSWpvaUluMD0=	1792014116
PkIcTEN4EICr4YtRiUPhLdHxkoG3gXhPT5jkz9zi	1	127.0.0.1	Python-urllib/3.14	ZXlKcGRpSTZJak0zTWpObFZFUXlhVTFVWTNGTFprOU9URXcwV0djOVBTSXNJblpoYkhWbElqb2lhVW92VG1kVlFWVTRNbWMzUjBaeldTdDRVamRuYVRKMUt6WnVZa2xLWkd4c1Qzb3dZMFp3VEV3dk5VUlJXRUZOYlUxRVRVeGtWekZVY2xFcmJHOHJkMkZ4VTA5MVNsQnRUMng1VHpSSk1pOTVOakpIUVc4NFdGVmlSM2RYU21wYWFGWk5kMVJsYUVOTFdqZFJPWGRDY25GRlVtdDFWakJHVEdrNGEzSjVhazEzS3paSFVEQjNVR0lyTTNOTmMwVXJWRzFpZVU5VlN6QklXbkV5VkdweGJ6UlJlbWx0YWxvMGFqUkVTR2xXTWxaM1dqVXdkRGd2UmxCQlNFWlJUSGhXUjNkRE9XWjRSMkpXY1V3MFYwRllabVJUTVV0ck9WVnVRM2wzUmpjeVJFZENZMlUwWVM5d1UwSndZM0JQU2tkb1JUUTNlamgwV25STWJXWXpOV2RxT0VFMU0yNUJlRWhzWlV3dlprczJkSEZOTmxCUVYyVjJRVkZVVUdwWmFFbERNRU5QY25wbFUwWjRTemc5SWl3aWJXRmpJam9pTWpGa01ETXhNRE16T0RZNFpHSmtOMk0wTmpsa1kyVmpaVEUzWVdJd05tTXlOelpsTkRRMU9UWm1aR1V5T0RVM056ZGxZV0k0TmpWalptUXdaRFJsTUNJc0luUmhaeUk2SWlKOQ==	1792014156
yucbfDJws18j6iPCYqdsGcFlXZmObzgJWvIhrLCr	1	127.0.0.1	Python-urllib/3.14	ZXlKcGRpSTZJbTlGTUVGRmFXUmpWVEJzVEdzeFkzUm9VMDUxUjBFOVBTSXNJblpoYkhWbElqb2lLMHRJYWt4RVltMUhjVmhMVkVNd1prYzBPRFZ0WWxGSldsaFdhMnB3YUZBNFdWTk5XalJNV0hFMVRVWlZPVVZZTXpCV1UwWlBVamRNSzFaMllXVmpORVZqTm5OV0x6bG9ZemxLV1RWbU5qWjVUSE5YTUdKbWNrNVZjSHBPWmpWcVZXcDNiRTl2VFhsak1WQjZRVVl4Um0xemFpOVBTVUZzTVRWeEsxWkJheXNyYWpOUVJWcHBkRFp5V1UxcFVuRTBTV2RuWVhjd1FWZHRiek4yVmpZM1NVTllPRlkxWWtwd2VURkxRa3R4WWtjelkyVXpRMUIzTlhrck9YVm9ZM05VY2tKRWFubDFXREJFY0dGa2FVdFVlVE5ZYUc0d1RWTmlTVWt4Y3pOcGFrUm9TWGMzVnpCUFdURkZkWEI2Wml0NVZ6Vk5NbUZuVEZJMmRIcGxjM0J6V1VaeGJVOW1NRFZPT0ZCdk5WbG1VR1JCZVVZMmJIcFhSalpzYmpOT04wMU9WR1JJYTIxUlYwTlJNVzU1YWtKQ2FWaElNemhoYlRSRFYyTlNMMVZUUkdRaUxDSnRZV01pT2lJeFpEQTJZalUwTjJSak1EVTFaakU1TmpBek4yTmlNek5oT0RWbU1tTm1ZV00yTm1Vek56aGpNREUwWVdOak9UZ3lOREV3TUdGaU9EUTFPR05qWWpBMElpd2lkR0ZuSWpvaUluMD0=	1792014190
\.


--
-- Data for Name: sikluses; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sikluses (id_siklus, id_tanaman, nama_siklus, waktu_siklus, created_at, updated_at, expires_at) FROM stdin;
1	1	Semai	7	2026-10-14 14:34:33	2026-10-14 14:34:33	\N
2	1	Peremajaan	14	2026-10-14 14:34:33	2026-10-14 14:34:33	\N
3	1	Pendewasaan	21	2026-10-14 14:34:33	2026-10-14 14:34:33	\N
4	3	Semai	7	2026-10-14 14:34:33	2026-10-14 14:34:33	\N
5	3	Peremajaan	14	2026-10-14 14:34:33	2026-10-14 14:34:33	\N
6	3	Pendewasaan	21	2026-10-14 14:34:33	2026-10-14 14:34:33	\N
\.


--
-- Data for Name: tanamen; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tanamen (id_tanaman, nama_tanaman, id_meja, created_at, updated_at, expires_at) FROM stdin;
1	Seledri	\N	2026-10-14 14:34:33	2026-10-14 14:34:33	\N
3	Selada	\N	2026-10-14 14:34:33	2026-10-14 14:34:33	\N
\.


--
-- Data for Name: target_nutrisi; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.target_nutrisi (id, id_tanaman, tahap, umur_min_hari, umur_max_hari, ec_min_ppm, ec_max_ppm, ph_min, ph_max, status, keterangan, sumber, updated_at) FROM stdin;
2	\N	Peremajaan	\N	\N	\N	\N	\N	\N	menunggu_konfirmasi	Nilai EC/pH BELUM DITENTUKAN — menunggu kesepakatan tim website (Lampiran B par.249); pagar EC sementara 400-1.250 ppm (par.251)	Perancangan_Sistem_IoT_Hidroponik_FINAL.docx Lampiran B par.249	2026-10-19 19:42:37.981012
3	\N	Pendewasaan	\N	\N	\N	\N	\N	\N	menunggu_konfirmasi	Nilai EC/pH BELUM DITENTUKAN — menunggu kesepakatan tim website (Lampiran B par.249); pagar EC sementara 400-1.250 ppm (par.251)	Perancangan_Sistem_IoT_Hidroponik_FINAL.docx Lampiran B par.249	2026-10-19 19:42:37.981012
1	\N	Semai	\N	\N	\N	\N	\N	\N	menunggu_konfirmasi	Nilai EC/pH BELUM DITENTUKAN — menunggu kesepakatan tim website (Lampiran B par.249); pagar EC sementara 400-1.250 ppm (par.251)	Perancangan_Sistem_IoT_Hidroponik_FINAL.docx Lampiran B par.249	2026-10-19 19:42:37.981012
\.


--
-- Data for Name: timing_operasi; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.timing_operasi (param, nilai, satuan, keterangan, sumber, diubah_pada) FROM stdin;
monitoring_menit	60.000	menit	Masa istirahat setelah target tercapai; tidak disuntik apa-apa	Perancangan FINAL Aturan 8 par.147 / Tabel 12	2026-10-19 19:42:37.870862
jeda_ab_menit	2.000	menit	Jeda keamanan A sebelum B (setelah bilas #1)	Perancangan FINAL seksi 4.2 par.74 / Tabel 12	2026-10-19 19:42:37.870862
jeda_a_ke_bilas_detik	3.000	detik	Rentang 2-3 detik setelah pulsa A sebelum BILAS #1 (nilai ambil batas atas)	Perancangan FINAL seksi 4.2 par.72 / Tabel 12	2026-10-19 19:42:37.870862
jeda_pasca_bilas_detik	2.000	detik	Rentang 1-2 detik setelah bilas sebelum hitung mundur 2 menit	Perancangan FINAL seksi 4.2 par.74	2026-10-19 19:42:37.870862
volume_bilas_ml	300.000	mL	Acuan bilas per ganti cairan; aturan >= 2x isi pipa; durasi detik = kalibrasi	Perancangan FINAL seksi 4.2 par.73/79 / Tabel 12	2026-10-19 19:42:37.870862
isi_botol_timeout_detik	60.000	detik	Awal; final = 2x hasil ukur. Lewat → pompa mati + ALERT	Perancangan FINAL seksi 4.1 par.66 / Tabel 13	2026-10-19 19:42:37.870862
isi_botol_normal_detik	30.000	detik	Isi botol sampai float penuh, rentang ±15-30 detik (terkalibrasi)	Perancangan FINAL Tabel 12	2026-10-19 19:42:37.870862
ronde_dosing_menit	20.000	menit	Satu ronde = dosing + mixing + baca	Perancangan FINAL Tabel 12 / seksi 2.3 par.52	2026-10-19 19:42:37.870862
jeda_pasca_isi_air_menit	2.000	menit	Baca segar minimal ±2 menit setelah isi selesai; perintah dosing lama dibatalkan	Perancangan FINAL Aturan 3 par.124-125	2026-10-19 19:42:37.870862
median_pembacaan_n	9.000	bacaan	Ambil nilai tengah dari 9 bacaan (buang noise kecil)	Perancangan FINAL Tabel 2 / 4.1 par.60	2026-10-19 19:42:37.870862
reset_counter_jam	0.000	jam (RTC)	Reset counter dosis & volume harian pukul 00:00; LOCK tidak ikut direset	Perancangan FINAL Aturan 11 par.159 / Tabel 12	2026-10-19 19:42:37.870862
limit_batas_ons_pompa	\N	detik	Batas waktu ON maksimum per pompa peristaltik + watchdog controller — NILAI BELUM DITENTUKAN (dokumen hanya menyebut kewajibannya)	Perancangan FINAL seksi 9 par.200	2026-10-19 19:42:37.870862
isi_air_timeout_menit	15.000	menit	Jam pasir pengaman isi air; final = 2x waktu isi normal; lewat → contactor OFF + ALERT	Perancangan FINAL Aturan 3 par.122 / Tabel 13	2026-10-19 19:42:37.870862
gap_besar_menit	48.000	menit	Contoh 102→700 ppm: 2 ronde ≈ 48 menit otomatis	Perancangan FINAL Tabel 5 / Tabel 12	2026-10-19 19:42:37.870862
mixing_menit	15.000	menit	Tunggu tercampur rata sebelum baca ulang — seragam semua penampung	Perancangan FINAL seksi 4.4 par.94 / Tabel 12	2026-10-19 19:42:37.870862
baca_stabil_timeout_detik	120.000	detik	Baca median 9 + stabil; lewat → ALERT sensor, bacaan dibuang	Perancangan FINAL Tabel 12 / Aturan 4 par.129	2026-10-19 19:42:37.870862
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, username, email, password, level, remember_token, created_at, updated_at, is_demo) FROM stdin;
2	demo	demo@vertonik.local	$2a$12$dtlbsxu36rR.pxE0uC7cpOKCCMSXWrHhEE53eG7rXOZsqyHKEsRpS	user	\N	2026-10-14 14:34:33	2026-10-19 12:36:08	t
3	petani	petani@vertonik.local	$2a$12$6OAxbZk8YixeLvN4MlLWQuyS7qhw.iSe3sBJD8LboC0tkcU36XM4m	petani	\N	2026-10-14 14:34:33	2026-10-20 13:22:48	f
1	garap	admin@politala.ac.id	$2a$12$4aaOl7rHbmb3.if7AW0C8.iw7J9kpZsZfYFvRX5wtkhJCVzGY.2Di	admin	\N	2026-10-14 14:34:32	2026-10-20 10:18:14	f
\.


--
-- Data for Name: wa_settings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.wa_settings (id, aktif, api_key, target, created_at, updated_at) FROM stdin;
1	t	gcm.d0kSRANUwa8XaGpHzow9El6pq8vy/pOKttNmr17sKhHzIfqHOA6vD94y2te0fw==	62812	2026-10-14 14:54:29	2026-10-15 06:29:39
\.


--
-- Data for Name: water_controls; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.water_controls (id, command, mode, updated_at, valve_state) FROM stdin;
1	FORCE_STOP	MANUAL	2026-10-21 12:22:53	OFF
\.


--
-- Data for Name: water_fill_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.water_fill_events (id, id_meja, id_sesi_kontaktor, mulai_pada, selesai_pada, durasi_detik, pemicu, dipicu_oleh, valve_sebelum, valve_sesudah, kontaktor_akhir, timeout_menit, hasil, alert_terpicu, keterangan, created_at) FROM stdin;
\.


--
-- Name: alert_logs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.alert_logs_id_seq', 51, true);


--
-- Name: audit_logs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.audit_logs_id_seq', 1, false);


--
-- Name: dosing_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.dosing_events_id_seq', 1, false);


--
-- Name: dosing_rounds_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.dosing_rounds_id_seq', 1, false);


--
-- Name: failed_jobs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.failed_jobs_id_seq', 1, false);


--
-- Name: jobs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.jobs_id_seq', 1, false);


--
-- Name: mejas_id_meja_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.mejas_id_meja_seq', 204, true);


--
-- Name: migrations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.migrations_id_seq', 22, true);


--
-- Name: monitorings_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.monitorings_id_seq', 100028, true);


--
-- Name: panens_id_panen_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.panens_id_panen_seq', 11, true);


--
-- Name: pendewasaans_id_pendewasaan_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.pendewasaans_id_pendewasaan_seq', 10, true);


--
-- Name: peremajaans_id_peremajaan_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.peremajaans_id_peremajaan_seq', 10, true);


--
-- Name: report_logs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.report_logs_id_seq', 1, false);


--
-- Name: semais_id_semai_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.semais_id_semai_seq', 50, true);


--
-- Name: sensor_overrides_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sensor_overrides_id_seq', 1, false);


--
-- Name: sensor_readings_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sensor_readings_id_seq', 1, false);


--
-- Name: sensor_thresholds_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sensor_thresholds_id_seq', 7, true);


--
-- Name: sikluses_id_siklus_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sikluses_id_siklus_seq', 25, true);


--
-- Name: tanamen_id_tanaman_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.tanamen_id_tanaman_seq', 30, true);


--
-- Name: target_nutrisi_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.target_nutrisi_id_seq', 3, true);


--
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.users_id_seq', 21, true);


--
-- Name: wa_settings_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.wa_settings_id_seq', 1, true);


--
-- Name: water_controls_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.water_controls_id_seq', 1, true);


--
-- Name: water_fill_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.water_fill_events_id_seq', 1, false);


--
-- Name: alert_logs alert_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_logs
    ADD CONSTRAINT alert_logs_pkey PRIMARY KEY (id);


--
-- Name: aturan_fail_safe aturan_fail_safe_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aturan_fail_safe
    ADD CONSTRAINT aturan_fail_safe_pkey PRIMARY KEY (kode);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: cache_locks cache_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cache_locks
    ADD CONSTRAINT cache_locks_pkey PRIMARY KEY (key);


--
-- Name: cache cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cache
    ADD CONSTRAINT cache_pkey PRIMARY KEY (key);


--
-- Name: dosing_events dosing_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dosing_events
    ADD CONSTRAINT dosing_events_pkey PRIMARY KEY (id);


--
-- Name: dosing_rounds dosing_rounds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dosing_rounds
    ADD CONSTRAINT dosing_rounds_pkey PRIMARY KEY (id);


--
-- Name: dosing_rounds dosing_rounds_unik; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dosing_rounds
    ADD CONSTRAINT dosing_rounds_unik UNIQUE (id_kejadian, ronde_ke);


--
-- Name: failed_jobs failed_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.failed_jobs
    ADD CONSTRAINT failed_jobs_pkey PRIMARY KEY (id);


--
-- Name: failed_jobs failed_jobs_uuid_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.failed_jobs
    ADD CONSTRAINT failed_jobs_uuid_unique UNIQUE (uuid);


--
-- Name: jadwal_perawatan jadwal_perawatan_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jadwal_perawatan
    ADD CONSTRAINT jadwal_perawatan_pkey PRIMARY KEY (kode);


--
-- Name: job_batches job_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_batches
    ADD CONSTRAINT job_batches_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: kalibrasi_sensor kalibrasi_sensor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kalibrasi_sensor
    ADD CONSTRAINT kalibrasi_sensor_pkey PRIMARY KEY (sensor);


--
-- Name: konfigurasi_dosis konfigurasi_dosis_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.konfigurasi_dosis
    ADD CONSTRAINT konfigurasi_dosis_pkey PRIMARY KEY (param);


--
-- Name: mapping_channel_esp32 mapping_channel_esp32_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mapping_channel_esp32
    ADD CONSTRAINT mapping_channel_esp32_pkey PRIMARY KEY (kode);


--
-- Name: mejas mejas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mejas
    ADD CONSTRAINT mejas_pkey PRIMARY KEY (id_meja);


--
-- Name: migrations migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations
    ADD CONSTRAINT migrations_pkey PRIMARY KEY (id);


--
-- Name: monitorings monitorings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitorings
    ADD CONSTRAINT monitorings_pkey PRIMARY KEY (id);


--
-- Name: panens panens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.panens
    ADD CONSTRAINT panens_pkey PRIMARY KEY (id_panen);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (email);


--
-- Name: penampung_states penampung_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.penampung_states
    ADD CONSTRAINT penampung_states_pkey PRIMARY KEY (id_meja);


--
-- Name: pendewasaans pendewasaans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pendewasaans
    ADD CONSTRAINT pendewasaans_pkey PRIMARY KEY (id_pendewasaan);


--
-- Name: peremajaans peremajaans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.peremajaans
    ADD CONSTRAINT peremajaans_pkey PRIMARY KEY (id_peremajaan);


--
-- Name: report_logs report_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_logs
    ADD CONSTRAINT report_logs_pkey PRIMARY KEY (id);


--
-- Name: semais semais_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semais
    ADD CONSTRAINT semais_pkey PRIMARY KEY (id_semai);


--
-- Name: sensor_overrides sensor_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_overrides
    ADD CONSTRAINT sensor_overrides_pkey PRIMARY KEY (id);


--
-- Name: sensor_readings sensor_readings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings
    ADD CONSTRAINT sensor_readings_pkey PRIMARY KEY (id_meja, created_at, id);


--
-- Name: sensor_readings_2026_07 sensor_readings_2026_07_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings_2026_07
    ADD CONSTRAINT sensor_readings_2026_07_pkey PRIMARY KEY (id_meja, created_at, id);


--
-- Name: sensor_readings_2026_08 sensor_readings_2026_08_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings_2026_08
    ADD CONSTRAINT sensor_readings_2026_08_pkey PRIMARY KEY (id_meja, created_at, id);


--
-- Name: sensor_readings_2026_09 sensor_readings_2026_09_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings_2026_09
    ADD CONSTRAINT sensor_readings_2026_09_pkey PRIMARY KEY (id_meja, created_at, id);


--
-- Name: sensor_readings_2026_10 sensor_readings_2026_10_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings_2026_10
    ADD CONSTRAINT sensor_readings_2026_10_pkey PRIMARY KEY (id_meja, created_at, id);


--
-- Name: sensor_readings_2026_11 sensor_readings_2026_11_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings_2026_11
    ADD CONSTRAINT sensor_readings_2026_11_pkey PRIMARY KEY (id_meja, created_at, id);


--
-- Name: sensor_readings_2026_12 sensor_readings_2026_12_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings_2026_12
    ADD CONSTRAINT sensor_readings_2026_12_pkey PRIMARY KEY (id_meja, created_at, id);


--
-- Name: sensor_readings_2027_01 sensor_readings_2027_01_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings_2027_01
    ADD CONSTRAINT sensor_readings_2027_01_pkey PRIMARY KEY (id_meja, created_at, id);


--
-- Name: sensor_readings_2027_02 sensor_readings_2027_02_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings_2027_02
    ADD CONSTRAINT sensor_readings_2027_02_pkey PRIMARY KEY (id_meja, created_at, id);


--
-- Name: sensor_readings_2027_03 sensor_readings_2027_03_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings_2027_03
    ADD CONSTRAINT sensor_readings_2027_03_pkey PRIMARY KEY (id_meja, created_at, id);


--
-- Name: sensor_readings_2027_04 sensor_readings_2027_04_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings_2027_04
    ADD CONSTRAINT sensor_readings_2027_04_pkey PRIMARY KEY (id_meja, created_at, id);


--
-- Name: sensor_readings_2027_05 sensor_readings_2027_05_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings_2027_05
    ADD CONSTRAINT sensor_readings_2027_05_pkey PRIMARY KEY (id_meja, created_at, id);


--
-- Name: sensor_readings_default sensor_readings_default_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings_default
    ADD CONSTRAINT sensor_readings_default_pkey PRIMARY KEY (id_meja, created_at, id);


--
-- Name: sensor_readings_hourly sensor_readings_hourly_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings_hourly
    ADD CONSTRAINT sensor_readings_hourly_pkey PRIMARY KEY (id_meja, bucket_start);


--
-- Name: sensor_readings_latest sensor_readings_latest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings_latest
    ADD CONSTRAINT sensor_readings_latest_pkey PRIMARY KEY (id_meja);


--
-- Name: sensor_thresholds sensor_thresholds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_thresholds
    ADD CONSTRAINT sensor_thresholds_pkey PRIMARY KEY (id);


--
-- Name: sensor_thresholds sensor_thresholds_sensor_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_thresholds
    ADD CONSTRAINT sensor_thresholds_sensor_unique UNIQUE (sensor);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sikluses sikluses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sikluses
    ADD CONSTRAINT sikluses_pkey PRIMARY KEY (id_siklus);


--
-- Name: tanamen tanamen_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tanamen
    ADD CONSTRAINT tanamen_pkey PRIMARY KEY (id_tanaman);


--
-- Name: target_nutrisi target_nutrisi_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.target_nutrisi
    ADD CONSTRAINT target_nutrisi_pkey PRIMARY KEY (id);


--
-- Name: timing_operasi timing_operasi_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timing_operasi
    ADD CONSTRAINT timing_operasi_pkey PRIMARY KEY (param);


--
-- Name: users users_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_unique UNIQUE (username);


--
-- Name: wa_settings wa_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_settings
    ADD CONSTRAINT wa_settings_pkey PRIMARY KEY (id);


--
-- Name: water_controls water_controls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.water_controls
    ADD CONSTRAINT water_controls_pkey PRIMARY KEY (id);


--
-- Name: water_fill_events water_fill_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.water_fill_events
    ADD CONSTRAINT water_fill_events_pkey PRIMARY KEY (id);


--
-- Name: alert_logs_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_logs_created_at_index ON public.alert_logs USING btree (created_at);


--
-- Name: alert_logs_type_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_logs_type_index ON public.alert_logs USING btree (type);


--
-- Name: cache_expiration_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cache_expiration_index ON public.cache USING btree (expiration);


--
-- Name: cache_locks_expiration_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cache_locks_expiration_index ON public.cache_locks USING btree (expiration);


--
-- Name: failed_jobs_connection_queue_failed_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX failed_jobs_connection_queue_failed_at_index ON public.failed_jobs USING btree (connection, queue, failed_at);


--
-- Name: idx_alertlogs_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alertlogs_created ON public.alert_logs USING btree (created_at DESC);


--
-- Name: idx_alertlogs_meja_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alertlogs_meja_created ON public.alert_logs USING btree (id_meja, created_at DESC);


--
-- Name: idx_alertlogs_type_value; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alertlogs_type_value ON public.alert_logs USING btree (type, value);


--
-- Name: idx_audit_logs_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_actor ON public.audit_logs USING btree (actor_user_id, terjadi_pada DESC);


--
-- Name: idx_audit_logs_aksi; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_aksi ON public.audit_logs USING btree (aksi, terjadi_pada DESC);


--
-- Name: idx_audit_logs_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_target ON public.audit_logs USING btree (tabel, row_id, terjadi_pada DESC);


--
-- Name: idx_audit_logs_waktu; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_waktu ON public.audit_logs USING btree (terjadi_pada DESC);


--
-- Name: idx_dosing_events_meja_hari; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dosing_events_meja_hari ON public.dosing_events USING btree (id_meja, hari DESC);


--
-- Name: idx_dosing_events_mulai; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dosing_events_mulai ON public.dosing_events USING btree (mulai_pada DESC);


--
-- Name: idx_dosing_events_pemicu; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dosing_events_pemicu ON public.dosing_events USING btree (pemicu, mulai_pada DESC);


--
-- Name: idx_dosing_rounds_kejadian; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dosing_rounds_kejadian ON public.dosing_rounds USING btree (id_kejadian);


--
-- Name: idx_monitorings_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_monitorings_created ON public.monitorings USING btree (created_at DESC);


--
-- Name: idx_monitorings_id_meja_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_monitorings_id_meja_created ON public.monitorings USING btree (id_meja, created_at DESC);


--
-- Name: idx_panens_tgl; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_panens_tgl ON public.panens USING btree (tgl_panen);


--
-- Name: idx_penampung_states_lock; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_penampung_states_lock ON public.penampung_states USING btree (status_lock) WHERE status_lock;


--
-- Name: idx_pendewasaans_tgl; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pendewasaans_tgl ON public.pendewasaans USING btree (tgl_awal_pendewasaan);


--
-- Name: idx_peremajaans_tgl; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_peremajaans_tgl ON public.peremajaans USING btree (tgl_awal_peremajaan);


--
-- Name: idx_readings_hourly_bucket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_readings_hourly_bucket ON public.sensor_readings_hourly USING btree (bucket_start DESC);


--
-- Name: idx_report_logs_aktor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_logs_aktor ON public.report_logs USING btree (dibuat_oleh, created_at DESC);


--
-- Name: idx_report_logs_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_logs_created ON public.report_logs USING btree (created_at DESC);


--
-- Name: idx_report_logs_jenis; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_logs_jenis ON public.report_logs USING btree (jenis, created_at DESC);


--
-- Name: idx_semais_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_semais_status ON public.semais USING btree (status);


--
-- Name: idx_semais_tgl; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_semais_tgl ON public.semais USING btree (tgl_awal_semai);


--
-- Name: idx_sensor_overrides_aktif; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sensor_overrides_aktif ON public.sensor_overrides USING btree (id_meja, status) WHERE ((status)::text = 'aktif'::text);


--
-- Name: idx_sensor_overrides_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sensor_overrides_created ON public.sensor_overrides USING btree (created_at DESC);


--
-- Name: idx_target_nutrisi_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_target_nutrisi_status ON public.target_nutrisi USING btree (status);


--
-- Name: idx_water_fill_meja_mulai; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_water_fill_meja_mulai ON public.water_fill_events USING btree (id_meja, mulai_pada DESC);


--
-- Name: idx_water_fill_mulai; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_water_fill_mulai ON public.water_fill_events USING btree (mulai_pada DESC);


--
-- Name: jobs_queue_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_queue_index ON public.jobs USING btree (queue);


--
-- Name: monitorings_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX monitorings_created_at_index ON public.monitorings USING btree (created_at);


--
-- Name: panens_id_pendewasaan_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX panens_id_pendewasaan_index ON public.panens USING btree (id_pendewasaan);


--
-- Name: pendewasaans_id_meja_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pendewasaans_id_meja_index ON public.pendewasaans USING btree (id_meja);


--
-- Name: pendewasaans_id_peremajaan_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pendewasaans_id_peremajaan_index ON public.pendewasaans USING btree (id_peremajaan);


--
-- Name: peremajaans_id_meja_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX peremajaans_id_meja_index ON public.peremajaans USING btree (id_meja);


--
-- Name: peremajaans_id_semai_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX peremajaans_id_semai_index ON public.peremajaans USING btree (id_semai);


--
-- Name: semais_id_meja_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX semais_id_meja_index ON public.semais USING btree (id_meja);


--
-- Name: semais_id_siklus_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX semais_id_siklus_index ON public.semais USING btree (id_siklus);


--
-- Name: semais_id_tanaman_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX semais_id_tanaman_index ON public.semais USING btree (id_tanaman);


--
-- Name: sessions_last_activity_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_last_activity_index ON public.sessions USING btree (last_activity);


--
-- Name: sessions_user_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_id_index ON public.sessions USING btree (user_id);


--
-- Name: uq_sensor_overrides_aktif; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_sensor_overrides_aktif ON public.sensor_overrides USING btree (id_meja, field) WHERE ((status)::text = 'aktif'::text);


--
-- Name: uq_target_nutrisi_global; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_target_nutrisi_global ON public.target_nutrisi USING btree (tahap) WHERE (id_tanaman IS NULL);


--
-- Name: uq_target_nutrisi_tanaman; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_target_nutrisi_tanaman ON public.target_nutrisi USING btree (id_tanaman, tahap, COALESCE(umur_min_hari, '-1'::integer)) WHERE (id_tanaman IS NOT NULL);


--
-- Name: sensor_readings_2026_07_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.sensor_readings_pkey ATTACH PARTITION public.sensor_readings_2026_07_pkey;


--
-- Name: sensor_readings_2026_08_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.sensor_readings_pkey ATTACH PARTITION public.sensor_readings_2026_08_pkey;


--
-- Name: sensor_readings_2026_09_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.sensor_readings_pkey ATTACH PARTITION public.sensor_readings_2026_09_pkey;


--
-- Name: sensor_readings_2026_10_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.sensor_readings_pkey ATTACH PARTITION public.sensor_readings_2026_10_pkey;


--
-- Name: sensor_readings_2026_11_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.sensor_readings_pkey ATTACH PARTITION public.sensor_readings_2026_11_pkey;


--
-- Name: sensor_readings_2026_12_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.sensor_readings_pkey ATTACH PARTITION public.sensor_readings_2026_12_pkey;


--
-- Name: sensor_readings_2027_01_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.sensor_readings_pkey ATTACH PARTITION public.sensor_readings_2027_01_pkey;


--
-- Name: sensor_readings_2027_02_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.sensor_readings_pkey ATTACH PARTITION public.sensor_readings_2027_02_pkey;


--
-- Name: sensor_readings_2027_03_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.sensor_readings_pkey ATTACH PARTITION public.sensor_readings_2027_03_pkey;


--
-- Name: sensor_readings_2027_04_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.sensor_readings_pkey ATTACH PARTITION public.sensor_readings_2027_04_pkey;


--
-- Name: sensor_readings_2027_05_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.sensor_readings_pkey ATTACH PARTITION public.sensor_readings_2027_05_pkey;


--
-- Name: sensor_readings_default_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.sensor_readings_pkey ATTACH PARTITION public.sensor_readings_default_pkey;


--
-- Name: alert_logs alert_logs_id_meja_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_logs
    ADD CONSTRAINT alert_logs_id_meja_fkey FOREIGN KEY (id_meja) REFERENCES public.mejas(id_meja) ON DELETE SET NULL;


--
-- Name: audit_logs audit_logs_actor_user_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_actor_user_foreign FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: dosing_events dosing_events_dipicu_oleh_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dosing_events
    ADD CONSTRAINT dosing_events_dipicu_oleh_foreign FOREIGN KEY (dipicu_oleh) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: dosing_events dosing_events_id_alert_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dosing_events
    ADD CONSTRAINT dosing_events_id_alert_foreign FOREIGN KEY (id_alert) REFERENCES public.alert_logs(id) ON DELETE SET NULL;


--
-- Name: dosing_events dosing_events_id_meja_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dosing_events
    ADD CONSTRAINT dosing_events_id_meja_foreign FOREIGN KEY (id_meja) REFERENCES public.mejas(id_meja) ON DELETE RESTRICT;


--
-- Name: dosing_rounds dosing_rounds_id_kejadian_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dosing_rounds
    ADD CONSTRAINT dosing_rounds_id_kejadian_foreign FOREIGN KEY (id_kejadian) REFERENCES public.dosing_events(id) ON DELETE CASCADE;


--
-- Name: monitorings monitorings_id_meja_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitorings
    ADD CONSTRAINT monitorings_id_meja_fkey FOREIGN KEY (id_meja) REFERENCES public.mejas(id_meja) ON DELETE SET NULL;


--
-- Name: panens panens_id_pendewasaan_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.panens
    ADD CONSTRAINT panens_id_pendewasaan_foreign FOREIGN KEY (id_pendewasaan) REFERENCES public.pendewasaans(id_pendewasaan) ON DELETE RESTRICT;


--
-- Name: penampung_states penampung_states_id_meja_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.penampung_states
    ADD CONSTRAINT penampung_states_id_meja_foreign FOREIGN KEY (id_meja) REFERENCES public.mejas(id_meja) ON DELETE CASCADE;


--
-- Name: pendewasaans pendewasaans_id_meja_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pendewasaans
    ADD CONSTRAINT pendewasaans_id_meja_foreign FOREIGN KEY (id_meja) REFERENCES public.mejas(id_meja) ON DELETE SET NULL;


--
-- Name: pendewasaans pendewasaans_id_peremajaan_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pendewasaans
    ADD CONSTRAINT pendewasaans_id_peremajaan_foreign FOREIGN KEY (id_peremajaan) REFERENCES public.peremajaans(id_peremajaan) ON DELETE SET NULL;


--
-- Name: peremajaans peremajaans_id_meja_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.peremajaans
    ADD CONSTRAINT peremajaans_id_meja_foreign FOREIGN KEY (id_meja) REFERENCES public.mejas(id_meja) ON DELETE SET NULL;


--
-- Name: peremajaans peremajaans_id_semai_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.peremajaans
    ADD CONSTRAINT peremajaans_id_semai_foreign FOREIGN KEY (id_semai) REFERENCES public.semais(id_semai) ON DELETE SET NULL;


--
-- Name: report_logs report_logs_dibuat_oleh_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_logs
    ADD CONSTRAINT report_logs_dibuat_oleh_foreign FOREIGN KEY (dibuat_oleh) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: semais semais_id_meja_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semais
    ADD CONSTRAINT semais_id_meja_foreign FOREIGN KEY (id_meja) REFERENCES public.mejas(id_meja) ON DELETE SET NULL;


--
-- Name: semais semais_id_siklus_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semais
    ADD CONSTRAINT semais_id_siklus_foreign FOREIGN KEY (id_siklus) REFERENCES public.sikluses(id_siklus) ON DELETE SET NULL;


--
-- Name: semais semais_id_tanaman_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semais
    ADD CONSTRAINT semais_id_tanaman_foreign FOREIGN KEY (id_tanaman) REFERENCES public.tanamen(id_tanaman) ON DELETE SET NULL;


--
-- Name: sensor_overrides sensor_overrides_dibuat_oleh_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_overrides
    ADD CONSTRAINT sensor_overrides_dibuat_oleh_foreign FOREIGN KEY (dibuat_oleh) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: sensor_overrides sensor_overrides_dihentikan_oleh_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_overrides
    ADD CONSTRAINT sensor_overrides_dihentikan_oleh_foreign FOREIGN KEY (dihentikan_oleh) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: sensor_overrides sensor_overrides_id_meja_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_overrides
    ADD CONSTRAINT sensor_overrides_id_meja_foreign FOREIGN KEY (id_meja) REFERENCES public.mejas(id_meja) ON DELETE CASCADE;


--
-- Name: sensor_readings_hourly sensor_readings_hourly_id_meja_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings_hourly
    ADD CONSTRAINT sensor_readings_hourly_id_meja_foreign FOREIGN KEY (id_meja) REFERENCES public.mejas(id_meja) ON DELETE CASCADE;


--
-- Name: sensor_readings sensor_readings_id_meja_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.sensor_readings
    ADD CONSTRAINT sensor_readings_id_meja_foreign FOREIGN KEY (id_meja) REFERENCES public.mejas(id_meja) ON DELETE CASCADE;


--
-- Name: sensor_readings_latest sensor_readings_latest_id_meja_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_readings_latest
    ADD CONSTRAINT sensor_readings_latest_id_meja_foreign FOREIGN KEY (id_meja) REFERENCES public.mejas(id_meja) ON DELETE CASCADE;


--
-- Name: sikluses sikluses_id_tanaman_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sikluses
    ADD CONSTRAINT sikluses_id_tanaman_foreign FOREIGN KEY (id_tanaman) REFERENCES public.tanamen(id_tanaman) ON DELETE SET NULL;


--
-- Name: tanamen tanamen_id_meja_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tanamen
    ADD CONSTRAINT tanamen_id_meja_foreign FOREIGN KEY (id_meja) REFERENCES public.mejas(id_meja) ON DELETE SET NULL;


--
-- Name: target_nutrisi target_nutrisi_id_tanaman_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.target_nutrisi
    ADD CONSTRAINT target_nutrisi_id_tanaman_foreign FOREIGN KEY (id_tanaman) REFERENCES public.tanamen(id_tanaman) ON DELETE CASCADE;


--
-- Name: water_fill_events water_fill_events_dipicu_oleh_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.water_fill_events
    ADD CONSTRAINT water_fill_events_dipicu_oleh_foreign FOREIGN KEY (dipicu_oleh) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: water_fill_events water_fill_events_id_meja_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.water_fill_events
    ADD CONSTRAINT water_fill_events_id_meja_foreign FOREIGN KEY (id_meja) REFERENCES public.mejas(id_meja) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

\unrestrict JbAim446yCLJqgm7xgIfQgkf40gfYzoK2khbslMk8IubdWX47fRdCz5AAwCofZX

