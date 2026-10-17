-- ============================================================================
-- SKEMA DATABASE — Vertonik Smart Farm (PostgreSQL 17)
-- 13 tabel domain (tanpa tabel sistem Laravel: sessions/cache/jobs/migrations)
-- Dihasilkan dari database live, 17 Okt 2026 — 35 index + 10 foreign key.
--
-- Pakai:  psql "$DATABASE_URL" -f database/schema.sql
-- Setelah itu ISI data awal: psql "$DATABASE_URL" -f database/seed.sql
-- ============================================================================
--
-- PostgreSQL database dump
--


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


CREATE TABLE public.alert_logs (
    id bigint NOT NULL,
    type character varying(50) NOT NULL,
    value character varying(100) NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(0) without time zone
);



CREATE SEQUENCE public.alert_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.alert_logs_id_seq OWNED BY public.alert_logs.id;



CREATE TABLE public.mejas (
    id_meja bigint NOT NULL,
    meja character varying(50) NOT NULL,
    jumlah_lubang integer NOT NULL,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    expires_at timestamp(0) without time zone
);



CREATE SEQUENCE public.mejas_id_meja_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.mejas_id_meja_seq OWNED BY public.mejas.id_meja;



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



CREATE SEQUENCE public.monitorings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.monitorings_id_seq OWNED BY public.monitorings.id;



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



CREATE SEQUENCE public.panens_id_panen_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.panens_id_panen_seq OWNED BY public.panens.id_panen;



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



CREATE SEQUENCE public.pendewasaans_id_pendewasaan_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.pendewasaans_id_pendewasaan_seq OWNED BY public.pendewasaans.id_pendewasaan;



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



CREATE SEQUENCE public.peremajaans_id_peremajaan_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.peremajaans_id_peremajaan_seq OWNED BY public.peremajaans.id_peremajaan;



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



CREATE SEQUENCE public.semais_id_semai_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.semais_id_semai_seq OWNED BY public.semais.id_semai;



CREATE TABLE public.sensor_thresholds (
    id bigint NOT NULL,
    sensor character varying(50) NOT NULL,
    min double precision,
    max double precision,
    updated_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);



CREATE SEQUENCE public.sensor_thresholds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.sensor_thresholds_id_seq OWNED BY public.sensor_thresholds.id;



CREATE TABLE public.sikluses (
    id_siklus bigint NOT NULL,
    id_tanaman bigint,
    nama_siklus character varying(100) NOT NULL,
    waktu_siklus integer NOT NULL,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    expires_at timestamp(0) without time zone
);



CREATE SEQUENCE public.sikluses_id_siklus_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.sikluses_id_siklus_seq OWNED BY public.sikluses.id_siklus;



CREATE TABLE public.tanamen (
    id_tanaman bigint NOT NULL,
    nama_tanaman character varying(50) NOT NULL,
    id_meja bigint,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    expires_at timestamp(0) without time zone
);



CREATE SEQUENCE public.tanamen_id_tanaman_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.tanamen_id_tanaman_seq OWNED BY public.tanamen.id_tanaman;



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



CREATE SEQUENCE public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;



CREATE TABLE public.wa_settings (
    id bigint NOT NULL,
    aktif boolean DEFAULT false NOT NULL,
    api_key text,
    target character varying(500),
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone
);



CREATE SEQUENCE public.wa_settings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.wa_settings_id_seq OWNED BY public.wa_settings.id;



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



CREATE SEQUENCE public.water_controls_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.water_controls_id_seq OWNED BY public.water_controls.id;


--
-- Name: alert_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_logs ALTER COLUMN id SET DEFAULT nextval('public.alert_logs_id_seq'::regclass);


--
-- Name: mejas id_meja; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mejas ALTER COLUMN id_meja SET DEFAULT nextval('public.mejas_id_meja_seq'::regclass);


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



ALTER TABLE ONLY public.alert_logs
    ADD CONSTRAINT alert_logs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.mejas
    ADD CONSTRAINT mejas_pkey PRIMARY KEY (id_meja);



ALTER TABLE ONLY public.monitorings
    ADD CONSTRAINT monitorings_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.panens
    ADD CONSTRAINT panens_pkey PRIMARY KEY (id_panen);



ALTER TABLE ONLY public.pendewasaans
    ADD CONSTRAINT pendewasaans_pkey PRIMARY KEY (id_pendewasaan);



ALTER TABLE ONLY public.peremajaans
    ADD CONSTRAINT peremajaans_pkey PRIMARY KEY (id_peremajaan);



ALTER TABLE ONLY public.semais
    ADD CONSTRAINT semais_pkey PRIMARY KEY (id_semai);



ALTER TABLE ONLY public.sensor_thresholds
    ADD CONSTRAINT sensor_thresholds_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.sensor_thresholds
    ADD CONSTRAINT sensor_thresholds_sensor_unique UNIQUE (sensor);



ALTER TABLE ONLY public.sikluses
    ADD CONSTRAINT sikluses_pkey PRIMARY KEY (id_siklus);



ALTER TABLE ONLY public.tanamen
    ADD CONSTRAINT tanamen_pkey PRIMARY KEY (id_tanaman);



ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);



ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_unique UNIQUE (username);



ALTER TABLE ONLY public.wa_settings
    ADD CONSTRAINT wa_settings_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.water_controls
    ADD CONSTRAINT water_controls_pkey PRIMARY KEY (id);



CREATE INDEX alert_logs_created_at_index ON public.alert_logs USING btree (created_at);



CREATE INDEX alert_logs_type_index ON public.alert_logs USING btree (type);



CREATE INDEX idx_alertlogs_created ON public.alert_logs USING btree (created_at DESC);



CREATE INDEX idx_alertlogs_type_value ON public.alert_logs USING btree (type, value);



CREATE INDEX idx_monitorings_created ON public.monitorings USING btree (created_at DESC);



CREATE INDEX idx_panens_tgl ON public.panens USING btree (tgl_panen);



CREATE INDEX idx_pendewasaans_tgl ON public.pendewasaans USING btree (tgl_awal_pendewasaan);



CREATE INDEX idx_peremajaans_tgl ON public.peremajaans USING btree (tgl_awal_peremajaan);



CREATE INDEX idx_semais_status ON public.semais USING btree (status);



CREATE INDEX idx_semais_tgl ON public.semais USING btree (tgl_awal_semai);



CREATE INDEX monitorings_created_at_index ON public.monitorings USING btree (created_at);



CREATE INDEX panens_id_pendewasaan_index ON public.panens USING btree (id_pendewasaan);



CREATE INDEX pendewasaans_id_meja_index ON public.pendewasaans USING btree (id_meja);



CREATE INDEX pendewasaans_id_peremajaan_index ON public.pendewasaans USING btree (id_peremajaan);



CREATE INDEX peremajaans_id_meja_index ON public.peremajaans USING btree (id_meja);



CREATE INDEX peremajaans_id_semai_index ON public.peremajaans USING btree (id_semai);



CREATE INDEX semais_id_meja_index ON public.semais USING btree (id_meja);



CREATE INDEX semais_id_siklus_index ON public.semais USING btree (id_siklus);



CREATE INDEX semais_id_tanaman_index ON public.semais USING btree (id_tanaman);


--
-- Name: panens panens_id_pendewasaan_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.panens
    ADD CONSTRAINT panens_id_pendewasaan_foreign FOREIGN KEY (id_pendewasaan) REFERENCES public.pendewasaans(id_pendewasaan) ON DELETE RESTRICT;


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


