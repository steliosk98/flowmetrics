BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_type text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  encrypted_config bytea,
  config_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_connected_at timestamptz,
  last_error_at timestamptz,
  last_error text
);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE RESTRICT,
  vendor text NOT NULL,
  vendor_device_id text NOT NULL,
  serial_number text,
  model text,
  name text NOT NULL,
  capacity_wh double precision CHECK (capacity_wh > 0),
  timezone text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  UNIQUE (connector_id, vendor_device_id)
);

CREATE TABLE telemetry_samples (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  battery_soc_pct double precision CHECK (battery_soc_pct BETWEEN 0 AND 100),
  battery_power_w double precision,
  battery_charge_power_w double precision CHECK (battery_charge_power_w >= 0),
  battery_discharge_power_w double precision CHECK (battery_discharge_power_w >= 0),
  solar_input_w double precision CHECK (solar_input_w >= 0),
  solar_input_1_w double precision CHECK (solar_input_1_w >= 0),
  solar_input_2_w double precision CHECK (solar_input_2_w >= 0),
  grid_input_w double precision CHECK (grid_input_w >= 0),
  grid_voltage_v double precision,
  grid_frequency_hz double precision,
  grid_connected boolean,
  ac_output_w double precision CHECK (ac_output_w >= 0),
  dc_output_w double precision CHECK (dc_output_w >= 0),
  total_output_w double precision CHECK (total_output_w >= 0),
  battery_temperature_c double precision,
  inverter_temperature_c double precision,
  battery_soh_pct double precision CHECK (battery_soh_pct BETWEEN 0 AND 100),
  cycle_count integer CHECK (cycle_count >= 0),
  device_online boolean,
  quality_flags integer NOT NULL DEFAULT 0,
  raw_payload jsonb,
  UNIQUE (device_id, observed_at)
);
CREATE INDEX telemetry_device_observed_desc ON telemetry_samples (device_id, observed_at DESC);
CREATE INDEX telemetry_observed_brin ON telemetry_samples USING brin (observed_at);

CREATE TABLE energy_hourly (
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  bucket_start timestamptz NOT NULL,
  solar_energy_wh double precision NOT NULL DEFAULT 0,
  grid_energy_wh double precision NOT NULL DEFAULT 0,
  battery_charge_wh double precision NOT NULL DEFAULT 0,
  battery_discharge_wh double precision NOT NULL DEFAULT 0,
  ac_output_wh double precision NOT NULL DEFAULT 0,
  dc_output_wh double precision NOT NULL DEFAULT 0,
  total_output_wh double precision NOT NULL DEFAULT 0,
  peak_solar_w double precision,
  peak_grid_w double precision,
  peak_output_w double precision,
  min_soc_pct double precision,
  max_soc_pct double precision,
  avg_soc_pct double precision,
  solar_active_seconds bigint NOT NULL DEFAULT 0,
  grid_import_seconds bigint NOT NULL DEFAULT 0,
  battery_charging_seconds bigint NOT NULL DEFAULT 0,
  battery_discharging_seconds bigint NOT NULL DEFAULT 0,
  sample_count bigint NOT NULL DEFAULT 0,
  valid_integration_seconds bigint NOT NULL DEFAULT 0,
  gap_seconds bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, bucket_start)
);

CREATE TABLE energy_daily (
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  timezone text NOT NULL,
  solar_energy_wh double precision NOT NULL DEFAULT 0,
  grid_energy_wh double precision NOT NULL DEFAULT 0,
  battery_charge_wh double precision NOT NULL DEFAULT 0,
  battery_discharge_wh double precision NOT NULL DEFAULT 0,
  ac_output_wh double precision NOT NULL DEFAULT 0,
  dc_output_wh double precision NOT NULL DEFAULT 0,
  total_output_wh double precision NOT NULL DEFAULT 0,
  peak_solar_w double precision,
  peak_solar_at timestamptz,
  peak_grid_w double precision,
  peak_grid_at timestamptz,
  peak_output_w double precision,
  peak_output_at timestamptz,
  min_soc_pct double precision,
  min_soc_at timestamptz,
  max_soc_pct double precision,
  max_soc_at timestamptz,
  solar_active_seconds bigint NOT NULL DEFAULT 0,
  grid_import_seconds bigint NOT NULL DEFAULT 0,
  battery_charging_seconds bigint NOT NULL DEFAULT 0,
  battery_discharging_seconds bigint NOT NULL DEFAULT 0,
  equivalent_cycle_fraction double precision,
  sample_count bigint NOT NULL DEFAULT 0,
  valid_integration_seconds bigint NOT NULL DEFAULT 0,
  gap_seconds bigint NOT NULL DEFAULT 0,
  coverage_pct double precision CHECK (coverage_pct BETWEEN 0 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, local_date)
);

CREATE TABLE device_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_seconds bigint,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  value_start double precision,
  value_end double precision,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, event_type, started_at)
);
CREATE INDEX events_device_started_desc ON device_events (device_id, started_at DESC);

CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE aggregation_state (
  device_id uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  last_integrated_sample_id bigint,
  last_integrated_at timestamptz,
  last_event_sample_id bigint,
  last_event_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations(version) VALUES ('001_initial') ON CONFLICT DO NOTHING;
COMMIT;
