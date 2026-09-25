/** Ordered SQL migrations. Never edit one that has shipped; add a new entry instead. */
export const migrations: { id: string; sql: string }[] = [
  {
    id: "001_init",
    sql: /* sql */ `
CREATE TABLE categories (
  slug text PRIMARY KEY,
  name text NOT NULL,
  group_name text NOT NULL,
  synonyms text[] NOT NULL DEFAULT '{}',
  -- normal; high_scam = verified businesses only; restricted/blocked = never searchable
  risk text NOT NULL DEFAULT 'normal' CHECK (risk IN ('normal', 'high_scam', 'restricted', 'blocked')),
  needs_location boolean NOT NULL DEFAULT true
);

CREATE TABLE areas (
  id serial PRIMARY KEY,
  name text NOT NULL,
  city text NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  UNIQUE (name, city)
);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('customer', 'business')),
  wa_id text NOT NULL,
  phone text,
  profile_name text,
  consent_at timestamptz,
  last_inbound_at timestamptz,
  is_blocked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, wa_id)
);

CREATE TABLE businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  keywords text NOT NULL DEFAULT '',
  phone text NOT NULL,
  area_id integer REFERENCES areas(id),
  address text,
  lat double precision,
  lng double precision,
  verification text NOT NULL DEFAULT 'registered' CHECK (verification IN ('verified', 'registered')),
  verified_at timestamptz,
  verified_by text,
  source text NOT NULL DEFAULT 'self' CHECK (source IN ('field', 'self', 'import')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'removed')),
  owner_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  opted_in_at timestamptz,
  response_score double precision NOT NULL DEFAULT 0.5,
  rating_sum integer NOT NULL DEFAULT 0,
  rating_count integer NOT NULL DEFAULT 0,
  is_sample boolean NOT NULL DEFAULT false,
  search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', name || ' ' || description || ' ' || keywords)
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX businesses_search_idx ON businesses USING gin (search_tsv);
CREATE INDEX businesses_phone_idx ON businesses (phone);
CREATE INDEX businesses_owner_idx ON businesses (owner_contact_id);

CREATE TABLE business_categories (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category_slug text NOT NULL REFERENCES categories(slug),
  PRIMARY KEY (business_id, category_slug)
);
CREATE INDEX business_categories_slug_idx ON business_categories (category_slug);

CREATE TABLE sessions (
  contact_id uuid PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  state jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  channel text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  wa_message_id text,
  kind text NOT NULL,
  body jsonb NOT NULL,
  status text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_wa_message_idx ON messages (wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX messages_contact_idx ON messages (contact_id, created_at);

CREATE TABLE requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  raw_text text NOT NULL,
  interpretation jsonb NOT NULL,
  category_slug text REFERENCES categories(slug),
  query text NOT NULL DEFAULT '',
  area_id integer REFERENCES areas(id),
  lat double precision,
  lng double precision,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'answered', 'no_results', 'connected', 'handoff', 'asked_around', 'closed')),
  result_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX requests_status_idx ON requests (status, created_at);

CREATE TABLE request_results (
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  rank integer NOT NULL,
  PRIMARY KEY (request_id, business_id)
);
CREATE INDEX request_results_business_idx ON request_results (business_id);

CREATE TABLE introductions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_code text NOT NULL UNIQUE,
  request_id uuid REFERENCES requests(id) ON DELETE SET NULL,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  outcome text CHECK (outcome IN ('sorted', 'not_yet', 'no_reply')),
  rating integer CHECK (rating BETWEEN 1 AND 5),
  followed_up_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX introductions_business_idx ON introductions (business_id, created_at);

CREATE TABLE ask_around (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  response text CHECK (response IN ('yes', 'no')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  UNIQUE (request_id, business_id)
);

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'actioned')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  run_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due_idx ON jobs (status, run_at);
`,
  },
  {
    id: "002_field_teams",
    sql: /* sql */ `
CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text,
  city text,
  -- sha256 of the agent's access token; the token itself is only ever shown once, in the setup link
  token_hash text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

ALTER TABLE businesses
  ADD COLUMN registered_by uuid REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN client_ref text,
  ADD COLUMN gps_accuracy_m double precision,
  -- field checklist, e.g. {"premisesSeen": true, "idChecked": true}; ID copies are never stored
  ADD COLUMN checks jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN audit_status text CHECK (audit_status IN ('passed', 'failed'));
CREATE UNIQUE INDEX businesses_client_ref_idx ON businesses (client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX businesses_registered_by_idx ON businesses (registered_by, created_at);

CREATE TABLE business_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('shopfront', 'inside', 'price_list')),
  storage_key text NOT NULL,
  content_type text NOT NULL,
  bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX business_photos_business_idx ON business_photos (business_id);

-- Call-back checks on field registrations.
CREATE TABLE audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  outcome text NOT NULL
    CHECK (outcome IN ('confirmed', 'details_wrong', 'wrong_number', 'not_a_business', 'refused')),
  note text,
  audited_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audits_agent_idx ON audits (agent_id, created_at);
CREATE INDEX audits_business_idx ON audits (business_id);
`,
  },
  {
    id: "003_answer_more_requests",
    sql: /* sql */ `
-- Synonyms added from the ops console. Kept apart from the seeded ones so reseeding never wipes them.
ALTER TABLE categories ADD COLUMN extra_synonyms text[] NOT NULL DEFAULT '{}';

-- Items read from price-list photos (sent by owners or taken by field agents).
CREATE TABLE offerings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  price_usd numeric(12, 2),
  -- the price as written, e.g. "$5/kg" or "ZiG 120"
  price_text text,
  photo_id uuid REFERENCES business_photos(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX offerings_business_idx ON offerings (business_id);

-- Search also covers price-list items. A generated column can't be altered, so rebuild it.
ALTER TABLE businesses ADD COLUMN offerings_text text NOT NULL DEFAULT '';
ALTER TABLE businesses DROP COLUMN search_tsv;
ALTER TABLE businesses ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', name || ' ' || description || ' ' || keywords || ' ' || offerings_text)
) STORED;
CREATE INDEX businesses_search_idx ON businesses USING gin (search_tsv);

-- Businesses found on the web when nothing is listed. Unverified, and kept only until
-- expires_at so the field team can invite them.
CREATE TABLE online_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  area_text text,
  area_id integer REFERENCES areas(id),
  lat double precision,
  lng double precision,
  category_slug text REFERENCES categories(slug),
  query text NOT NULL DEFAULT '',
  source_url text NOT NULL,
  source_title text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'invited')),
  times_shown integer NOT NULL DEFAULT 0,
  times_connected integer NOT NULL DEFAULT 0,
  found_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX online_leads_category_idx ON online_leads (category_slug, expires_at);

CREATE TABLE request_online_results (
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES online_leads(id) ON DELETE CASCADE,
  rank integer NOT NULL,
  PRIMARY KEY (request_id, lead_id)
);

-- Businesses that asked never to be shown from web results. Only a hash of the number is kept.
CREATE TABLE online_optouts (
  phone_hash text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- When a request triggered a web search, for the per-customer daily limit.
ALTER TABLE requests
  ADD COLUMN online_searched_at timestamptz,
  ADD COLUMN online_results integer NOT NULL DEFAULT 0;
CREATE INDEX requests_online_idx ON requests (contact_id, online_searched_at);

-- Customers' tips about good businesses we don't list yet.
CREATE TABLE recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  name text NOT NULL,
  what text NOT NULL,
  category_slug text REFERENCES categories(slug),
  area_text text,
  area_id integer REFERENCES areas(id),
  phone text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'listed', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recommendations_status_idx ON recommendations (status, created_at);
`,
  },
  {
    id: "004_launch_readiness",
    sql: /* sql */ `
-- Inbound messages are saved before WhatsApp gets its 200, then handled; processed_at marks
-- them done. Anything left unprocessed by a crash is picked up again.
ALTER TABLE messages
  ADD COLUMN processed_at timestamptz,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  -- who sent an inbound message, so it can be handled again even if the contact wasn't saved yet
  ADD COLUMN sender jsonb,
  -- what we understood from a photo or voice note, kept apart from the message itself
  ADD COLUMN notes jsonb NOT NULL DEFAULT '{}';
UPDATE messages SET processed_at = created_at WHERE direction = 'in';
UPDATE messages
   SET notes = jsonb_strip_nulls(jsonb_build_object('transcript', body->'transcript', 'language', body->'language', 'seen', body->'seen')),
       body = body - 'transcript' - 'language' - 'seen'
 WHERE direction = 'in' AND (body ? 'transcript' OR body ? 'seen');
CREATE INDEX messages_unprocessed_idx ON messages (created_at) WHERE direction = 'in' AND processed_at IS NULL;

-- Reports from customers who contacted the business through us carry more weight.
ALTER TABLE reports ADD COLUMN had_introduction boolean NOT NULL DEFAULT false;
CREATE INDEX reports_business_idx ON reports (business_id, created_at);

ALTER TABLE contacts ADD COLUMN blocked_reason text;

-- One account per person on the ops team.
CREATE TABLE ops_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  -- scrypt; the password itself is never stored
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE ops_sessions (
  -- sha256 of the session token; the token is only held by the browser
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES ops_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX ops_sessions_user_idx ON ops_sessions (user_id);

-- Who did what in the ops console.
CREATE TABLE ops_audit (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES ops_users(id) ON DELETE SET NULL,
  actor text NOT NULL,
  action text NOT NULL,
  target text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ops_audit_created_idx ON ops_audit (created_at);
`,
  },
];
