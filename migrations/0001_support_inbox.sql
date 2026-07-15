-- Support inbox tables (@infra-agent/support-inbox).
-- Global on purpose: the support inbox is an instance-admin surface with no
-- tenant context, so no org scoping or tenant_isolation policy applies.
-- Idempotent so the migrate runner can re-apply the full set safely.
--
-- This file is the package's canonical DDL. Hosts copy it VERBATIM (with a
-- "copied from" header) into their own migration directory; the package ships
-- additive numbered migrations and hosts copy each new one on upgrade.

CREATE TABLE IF NOT EXISTS support_threads (
  id text PRIMARY KEY,
  subject text NOT NULL,
  normalized_subject text NOT NULL,
  customer_email text NOT NULL,
  customer_name text,
  status text NOT NULL DEFAULT 'open',
  unread boolean NOT NULL DEFAULT true,
  inbound_address text,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  last_message_snippet text,
  message_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE support_threads
    ADD CONSTRAINT support_threads_status_check
    CHECK (status IN ('open', 'closed', 'spam'));
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

CREATE INDEX IF NOT EXISTS support_threads_status_last_message_idx
  ON support_threads (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS support_threads_customer_subject_idx
  ON support_threads (customer_email, normalized_subject);
CREATE INDEX IF NOT EXISTS support_threads_unread_idx
  ON support_threads (last_message_at) WHERE unread;

CREATE TABLE IF NOT EXISTS support_messages (
  id text PRIMARY KEY,
  thread_id text NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  direction text NOT NULL,
  -- Inbound idempotency arbiter (unique below; PG allows many NULLs for outbound).
  resend_inbound_id text,
  -- Outbound idempotency arbiter: client-generated UUID per reply attempt,
  -- also passed to Resend as the send idempotency key.
  reply_attempt_id text,
  resend_outbound_id text,
  -- RFC 5322 Message-ID, with angle brackets.
  message_id text,
  in_reply_to text,
  -- "references" is a Postgres reserved word, hence the suffix.
  references_header text,
  reply_to text,
  from_email text NOT NULL,
  from_name text,
  to_emails jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_emails jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text NOT NULL DEFAULT '',
  text_body text,
  html_body text,
  body_truncated boolean NOT NULL DEFAULT false,
  snippet text,
  actor_id text,
  actor_label text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE support_messages
    ADD CONSTRAINT support_messages_direction_check
    CHECK (direction IN ('inbound', 'outbound'));
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS support_messages_resend_inbound_id_idx
  ON support_messages (resend_inbound_id);
CREATE UNIQUE INDEX IF NOT EXISTS support_messages_reply_attempt_id_idx
  ON support_messages (reply_attempt_id);
CREATE INDEX IF NOT EXISTS support_messages_thread_sent_idx
  ON support_messages (thread_id, sent_at);
CREATE INDEX IF NOT EXISTS support_messages_message_id_idx
  ON support_messages (message_id);

CREATE TABLE IF NOT EXISTS support_attachments (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES support_messages(id) ON DELETE CASCADE,
  resend_attachment_id text NOT NULL,
  filename text NOT NULL DEFAULT 'attachment',
  content_type text,
  content_disposition text,
  content_id text,
  size_bytes integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_attachments_message_id_idx
  ON support_attachments (message_id);

-- Instance-admin surface, not org-scoped: no tenant_isolation policy applies.
ALTER TABLE support_threads DISABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE support_attachments DISABLE ROW LEVEL SECURITY;

-- Same tolerance as 0000_init: managed hosts may lack the roles or privilege.
DO $$
BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON support_threads TO infra_agent_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON support_messages TO infra_agent_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON support_attachments TO infra_agent_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON support_threads TO infra_agent_admin;
  GRANT SELECT, INSERT, UPDATE, DELETE ON support_messages TO infra_agent_admin;
  GRANT SELECT, INSERT, UPDATE, DELETE ON support_attachments TO infra_agent_admin;
EXCEPTION WHEN undefined_object OR insufficient_privilege THEN
  RAISE NOTICE 'skip GRANTs (roles missing or insufficient privilege)';
END
$$;
