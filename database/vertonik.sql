--
-- PostgreSQL database dump
--

\restrict Ma7sdwRMmdvOFxmMdNDvROsisEypjPXe6pcMxCitLhi2KS6Cc8tJdG0pcOSnumk

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
-- Name: alert_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_logs (
    id bigint NOT NULL,
    type character varying(50) NOT NULL,
    value character varying(100) NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(0) without time zone
);


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
-- Name: mejas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mejas (
    id_meja bigint NOT NULL,
    meja character varying(50) NOT NULL,
    jumlah_lubang integer NOT NULL,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    expires_at timestamp(0) without time zone
);


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
    updated_at timestamp(0) without time zone
);


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
-- Name: sensor_thresholds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_thresholds (
    id bigint NOT NULL,
    sensor character varying(50) NOT NULL,
    min double precision,
    max double precision,
    updated_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


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

COPY public.alert_logs (id, type, value, created_at, updated_at) FROM stdin;
1	solenoid	ON (uji node)	2026-10-15 06:08:40	2026-10-15 06:08:40
2	solenoid	ON (uji node)	2026-10-15 06:11:32	2026-10-15 06:11:32
3	uji	x0	2026-10-15 06:30:03	2026-10-15 06:30:03
4	uji	x1	2026-10-15 06:30:03	2026-10-15 06:30:03
5	uji	x2	2026-10-15 06:30:03	2026-10-15 06:30:03
6	uji	x3	2026-10-15 06:30:03	2026-10-15 06:30:03
7	uji	x4	2026-10-15 06:30:03	2026-10-15 06:30:03
8	uji	x5	2026-10-15 06:30:03	2026-10-15 06:30:03
9	uji	x6	2026-10-15 06:30:03	2026-10-15 06:30:03
10	uji	x7	2026-10-15 06:30:03	2026-10-15 06:30:03
11	uji	x8	2026-10-15 06:30:03	2026-10-15 06:30:03
12	uji	x9	2026-10-15 06:30:03	2026-10-15 06:30:03
13	uji	x10	2026-10-15 06:30:03	2026-10-15 06:30:03
14	uji	x11	2026-10-15 06:30:03	2026-10-15 06:30:03
15	uji	x12	2026-10-15 06:30:03	2026-10-15 06:30:03
16	uji	x13	2026-10-15 06:30:03	2026-10-15 06:30:03
17	uji	x14	2026-10-15 06:30:03	2026-10-15 06:30:03
18	uji	x15	2026-10-15 06:30:03	2026-10-15 06:30:03
19	uji	x16	2026-10-15 06:30:03	2026-10-15 06:30:03
20	uji	x17	2026-10-15 06:30:03	2026-10-15 06:30:03
21	uji	x18	2026-10-15 06:30:03	2026-10-15 06:30:03
22	uji	x19	2026-10-15 06:30:03	2026-10-15 06:30:03
23	uji	x20	2026-10-15 06:30:03	2026-10-15 06:30:03
24	uji	x21	2026-10-15 06:30:03	2026-10-15 06:30:03
25	uji	x22	2026-10-15 06:30:03	2026-10-15 06:30:03
26	uji	x23	2026-10-15 06:30:03	2026-10-15 06:30:03
27	uji	x24	2026-10-15 06:30:03	2026-10-15 06:30:03
28	uji	x25	2026-10-15 06:30:03	2026-10-15 06:30:03
29	uji	x26	2026-10-15 06:30:03	2026-10-15 06:30:03
30	uji	x27	2026-10-15 06:30:03	2026-10-15 06:30:03
31	uji	x28	2026-10-15 06:30:03	2026-10-15 06:30:03
32	uji	x29	2026-10-15 06:30:03	2026-10-15 06:30:03
33	uji	x30	2026-10-15 06:30:03	2026-10-15 06:30:03
34	uji	x31	2026-10-15 06:30:03	2026-10-15 06:30:03
35	uji	x32	2026-10-15 06:30:03	2026-10-15 06:30:03
36	uji	x33	2026-10-15 06:30:03	2026-10-15 06:30:03
37	uji	x34	2026-10-15 06:30:03	2026-10-15 06:30:03
38	uji	x35	2026-10-15 06:30:03	2026-10-15 06:30:03
39	uji	x36	2026-10-15 06:30:03	2026-10-15 06:30:03
40	uji	x37	2026-10-15 06:30:03	2026-10-15 06:30:03
41	uji	x38	2026-10-15 06:30:03	2026-10-15 06:30:03
42	uji	x39	2026-10-15 06:30:03	2026-10-15 06:30:03
43	uji	x40	2026-10-15 06:30:03	2026-10-15 06:30:03
44	uji	x41	2026-10-15 06:30:03	2026-10-15 06:30:03
45	uji	x42	2026-10-15 06:30:03	2026-10-15 06:30:03
46	uji	x43	2026-10-15 06:30:03	2026-10-15 06:30:03
47	uji	x44	2026-10-15 06:30:03	2026-10-15 06:30:03
48	uji	x45	2026-10-15 06:30:03	2026-10-15 06:30:03
49	uji	x46	2026-10-15 06:30:03	2026-10-15 06:30:03
50	uji	x47	2026-10-15 06:30:03	2026-10-15 06:30:03
51	uji	x	2026-10-15 06:44:51	2026-10-15 06:44:51
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
-- Data for Name: failed_jobs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.failed_jobs (id, uuid, connection, queue, payload, exception, failed_at) FROM stdin;
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
-- Data for Name: mejas; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.mejas (id_meja, meja, jumlah_lubang, created_at, updated_at, expires_at) FROM stdin;
3	Meja Selada	10	2026-10-14 14:34:33	2026-10-14 14:34:33	\N
8	Peremajaan 1	624	2026-10-14 14:34:33	2026-10-14 14:34:33	\N
9	Peremajaan 2	312	2026-10-14 14:34:33	2026-10-14 14:34:33	\N
10	Pendewasaan 1	200	2026-10-14 14:34:33	2026-10-14 14:34:33	\N
11	Pendewasaan 2	200	2026-10-14 14:34:33	2026-10-14 14:34:33	\N
2	MEJA-DEMO	12	\N	\N	2026-10-15 07:11:32
4	X-DEMO	2	\N	\N	2026-10-15 07:14:54
5	X-DEMO-FINAL	2	\N	\N	2026-10-15 07:16:49
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

COPY public.monitorings (id, "waterTemp", ph, tds, "airTemp", humidity, water_level, created_at, updated_at) FROM stdin;
1	26.1	6.4	1180	31.2	68	Sedang	2026-10-15 06:11:32	2026-10-15 06:11:32
2	26.2	6.3	1150	31	67	Sedang	2026-10-15 06:14:20	2026-10-15 06:14:20
3	26	6.4	1180	31	68	Load	2026-10-15 06:31:36	2026-10-15 06:31:36
5	26	6.4	1180	31	68	Load	2026-10-15 06:31:36	2026-10-15 06:31:36
4	26	6.4	1180	31	68	Load	2026-10-15 06:31:36	2026-10-15 06:31:36
6	26.2	6.3	1150	31	67	Sedang	2026-10-15 06:39:20	2026-10-15 06:39:20
7	26.5	6.4	1180	31	68	Sedang	2026-10-15 06:39:56	2026-10-15 06:39:56
8	26	6.4	1180	31	68	Load	2026-10-15 06:39:57	2026-10-15 06:39:57
9	26	6.4	1180	31	68	Load	2026-10-15 06:39:57	2026-10-15 06:39:57
10	26	6.4	1180	31	68	Load	2026-10-15 06:39:57	2026-10-15 06:39:57
11	26	6.4	1180	31	68	Load	2026-10-15 06:39:57	2026-10-15 06:39:57
100012	26.9	6.5	1200	31	66	Sedang	2026-10-15 06:43:58	2026-10-15 06:43:58
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
-- Data for Name: semais; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.semais (id_semai, id_tanaman, id_siklus, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, keterangan, benih_berhasil, benih_gagal, created_at, updated_at, expires_at, id_meja) FROM stdin;
15	3	3	200	2026-05-02	2026-05-07	selesai	ada	150	50	2026-10-14 14:34:33	2026-10-14 14:34:33	\N	\N
16	3	3	1000	2026-05-19	2026-05-24	selesai		800	200	2026-10-14 14:34:33	2026-10-14 14:34:33	\N	\N
\.


--
-- Data for Name: sensor_thresholds; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sensor_thresholds (id, sensor, min, max, updated_at) FROM stdin;
1	waterTemp	5	40	2026-10-14 22:34:33
2	ph	5	7	2026-10-14 22:34:33
3	tds	50	1000	2026-10-14 22:34:33
4	airTemp	20	40	2026-10-14 22:34:33
5	humidity	50	90	2026-10-14 22:34:33
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
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, username, email, password, level, remember_token, created_at, updated_at, is_demo) FROM stdin;
1	admin	admin@politala.ac.id	$2y$12$iw2XEuLEcvsussbCTJgm9u8XDYOWRgwM3xx7zpKjnUod1X7oSVya.	admin	\N	2026-10-14 14:34:32	2026-10-14 14:34:32	f
2	demo	demo@vertonik.local	$2y$12$EzhiHCvLimRt1k.I4K5cd.p6OPhNaCJ1elQUWQjxAuSILsVvbO7xa	user	\N	2026-10-14 14:34:33	2026-10-14 14:34:33	t
3	petani	petani@vertonik.local	$2y$12$VWM1BJh5vmne7rsbmt1ZgudwVvntdalEb.oSspKsuFTUb3wUoyhlu	petani	\N	2026-10-14 14:34:33	2026-10-14 14:34:33	f
\.


--
-- Data for Name: water_controls; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.water_controls (id, command, mode, updated_at, valve_state) FROM stdin;
1	AUTO	MANUAL	2026-10-15 06:43:58	OFF
\.


--
-- Name: alert_logs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.alert_logs_id_seq', 51, true);


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

SELECT pg_catalog.setval('public.mejas_id_meja_seq', 5, true);


--
-- Name: migrations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.migrations_id_seq', 22, true);


--
-- Name: monitorings_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.monitorings_id_seq', 100012, true);


--
-- Name: panens_id_panen_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.panens_id_panen_seq', 1, false);


--
-- Name: pendewasaans_id_pendewasaan_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.pendewasaans_id_pendewasaan_seq', 1, false);


--
-- Name: peremajaans_id_peremajaan_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.peremajaans_id_peremajaan_seq', 1, false);


--
-- Name: semais_id_semai_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.semais_id_semai_seq', 1, false);


--
-- Name: sensor_thresholds_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sensor_thresholds_id_seq', 5, true);


--
-- Name: sikluses_id_siklus_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sikluses_id_siklus_seq', 6, true);


--
-- Name: tanamen_id_tanaman_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.tanamen_id_tanaman_seq', 1, false);


--
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.users_id_seq', 3, true);


--
-- Name: wa_settings_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.wa_settings_id_seq', 1, true);


--
-- Name: water_controls_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.water_controls_id_seq', 1, true);


--
-- Name: alert_logs alert_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_logs
    ADD CONSTRAINT alert_logs_pkey PRIMARY KEY (id);


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
-- Name: semais semais_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semais
    ADD CONSTRAINT semais_pkey PRIMARY KEY (id_semai);


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
-- Name: idx_alertlogs_type_value; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alertlogs_type_value ON public.alert_logs USING btree (type, value);


--
-- Name: idx_monitorings_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_monitorings_created ON public.monitorings USING btree (created_at DESC);


--
-- Name: idx_panens_tgl; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_panens_tgl ON public.panens USING btree (tgl_panen);


--
-- Name: idx_pendewasaans_tgl; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pendewasaans_tgl ON public.pendewasaans USING btree (tgl_awal_pendewasaan);


--
-- Name: idx_peremajaans_tgl; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_peremajaans_tgl ON public.peremajaans USING btree (tgl_awal_peremajaan);


--
-- Name: idx_semais_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_semais_status ON public.semais USING btree (status);


--
-- Name: idx_semais_tgl; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_semais_tgl ON public.semais USING btree (tgl_awal_semai);


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
-- Name: panens panens_id_pendewasaan_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.panens
    ADD CONSTRAINT panens_id_pendewasaan_foreign FOREIGN KEY (id_pendewasaan) REFERENCES public.pendewasaans(id_pendewasaan) ON DELETE CASCADE;


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
-- PostgreSQL database dump complete
--

\unrestrict Ma7sdwRMmdvOFxmMdNDvROsisEypjPXe6pcMxCitLhi2KS6Cc8tJdG0pcOSnumk

