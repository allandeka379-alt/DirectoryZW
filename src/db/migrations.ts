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
];
