-- Support inbox settings (@arvo/support-inbox, Reacharound mode).
-- One row, id 'reacharound': the brand's inbox key as the Email page's
-- Settings saved it, encrypted by the package (AES-256-GCM under a key derived
-- from the host's secret), its last four characters for the dialog, and who
-- saved it. Self-hosted installs don't use it; it is harmless there.
-- Idempotent, like 0001. Hosts copy it VERBATIM (with a "copied from" header)
-- into their own migration directory.

CREATE TABLE IF NOT EXISTS support_inbox_settings (
  id text PRIMARY KEY,
  reacharound_key_encrypted text,
  reacharound_key_hint text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
