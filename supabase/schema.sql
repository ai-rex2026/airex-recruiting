-- AI-Rex Recruiting — schema (idempotent)
-- 広告リクルーティング業務 AI化アプリ

create extension if not exists "pgcrypto";

-- ============ tenant / user ============
create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  send_mode text not null default 'approval', -- approval | auto
  rate_limit_per_hour int not null default 30,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  full_name text not null default '',
  role text not null default 'operator', -- admin | operator | reviewer | viewer
  sender_name text not null default '',
  signature text not null default '',
  created_at timestamptz not null default now()
);

-- ============ client / campaign / keyword ============
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  client_id uuid references clients(id) on delete set null,
  name text not null,
  product_name text not null default '',
  lp_url text not null default '',
  unit_price text not null default '',
  conversion_point text not null default '',
  approval_terms text not null default '',
  selling_points text not null default '',
  status text not null default 'active', -- active | paused | closed
  created_at timestamptz not null default now()
);

create table if not exists keywords (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  keyword text not null,
  priority int not null default 3,
  created_at timestamptz not null default now()
);
create index if not exists idx_keywords_campaign on keywords(campaign_id);

-- ============ media ledger (tenant-scoped, cross-campaign) ============
create table if not exists media (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  domain text not null,               -- normalized domain (unique key within tenant)
  name text not null default '',
  operator text not null default '',
  category text not null default '',
  asp_type text not null default 'unknown', -- direct | asp | unknown
  asp_name text not null default '',
  no_solicitation boolean not null default false,
  no_solicitation_reason text not null default '',
  score numeric not null default 0,
  note text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists uq_media_tenant_domain on media(tenant_id, domain);

create table if not exists media_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  media_id uuid not null references media(id) on delete cascade,
  kind text not null default 'form', -- form | mail | dm
  value text not null,
  last_checked_at timestamptz,
  reachable boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_media_contacts_media on media_contacts(media_id);

create table if not exists asp_master (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  domain text not null,
  asp_name text not null
);
create unique index if not exists uq_asp_tenant_domain on asp_master(tenant_id, domain);

-- ============ SERP snapshots (time series) ============
create table if not exists serp_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  keyword_id uuid not null references keywords(id) on delete cascade,
  collected_at timestamptz not null default now(),
  source text not null default 'manual', -- manual | serp_api
  created_by uuid references profiles(id) on delete set null
);
create index if not exists idx_snap_keyword on serp_snapshots(keyword_id, collected_at desc);

create table if not exists serp_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  snapshot_id uuid not null references serp_snapshots(id) on delete cascade,
  media_id uuid references media(id) on delete set null,
  rank int,
  article_url text not null default '',
  article_title text not null default '',
  is_ranking_article boolean not null default false,
  judge_reason text not null default '',
  own_listed boolean not null default false,
  own_rank_in_article int
);
create index if not exists idx_entries_snapshot on serp_entries(snapshot_id);

create table if not exists article_listings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  serp_entry_id uuid not null references serp_entries(id) on delete cascade,
  position int,
  service_name text not null default '',
  is_own boolean not null default false
);
create index if not exists idx_listings_entry on article_listings(serp_entry_id);

-- ============ outreach ============
create table if not exists outreach_targets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  media_id uuid not null references media(id) on delete cascade,
  kind text not null default 'new',   -- new | replace
  status text not null default 'collected',
  status_reason text not null default '',
  article_url text not null default '',
  rank int,
  owner_id uuid references profiles(id) on delete set null,
  next_action_on date,
  negotiation_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_outreach_campaign_media on outreach_targets(campaign_id, media_id);
create index if not exists idx_outreach_status on outreach_targets(tenant_id, status);

create table if not exists templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  kind text not null default 'new', -- new | replace
  subject text not null default '',
  body text not null,
  max_chars int,
  created_at timestamptz not null default now()
);

create table if not exists message_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  outreach_target_id uuid not null references outreach_targets(id) on delete cascade,
  template_id uuid references templates(id) on delete set null,
  version int not null default 1,
  subject text not null default '',
  body text not null,
  origin text not null default 'ai', -- ai | human
  approved_by uuid references profiles(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_drafts_target on message_drafts(outreach_target_id, version desc);

create table if not exists send_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  outreach_target_id uuid not null references outreach_targets(id) on delete cascade,
  contact_id uuid references media_contacts(id) on delete set null,
  draft_id uuid references message_drafts(id) on delete set null,
  channel text not null default 'form',
  queued_at timestamptz not null default now(),
  scheduled_for timestamptz,
  sent_at timestamptz,
  result text not null default 'queued', -- queued | success | uncertain | form_error | url_error | captcha | no_solicitation | manual
  error_detail text not null default '',
  evidence_path text not null default '',
  approved_by uuid references profiles(id) on delete set null
);
create index if not exists idx_attempts_result on send_attempts(tenant_id, result);

create table if not exists replies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  outreach_target_id uuid not null references outreach_targets(id) on delete cascade,
  received_at timestamptz not null default now(),
  body text not null,
  ai_class text not null default '',      -- placeable | negotiating | rejected | irrelevant
  ai_summary text not null default '',
  extracted_terms text not null default '',
  final_class text not null default '',
  confirmed_by uuid references profiles(id) on delete set null,
  confirmed_at timestamptz
);
create index if not exists idx_replies_target on replies(outreach_target_id);

create table if not exists placements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  outreach_target_id uuid not null references outreach_targets(id) on delete cascade,
  article_url text not null default '',
  position_in_article int,
  unit_price text not null default '',
  started_on date,
  ended_on date,
  evidence_path text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  period_from date,
  period_to date,
  generated_at timestamptz not null default now(),
  summary text not null default ''
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  actor_id uuid references profiles(id) on delete set null,
  actor_name text not null default '',
  entity text not null,
  entity_id uuid,
  action text not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_created on audit_logs(tenant_id, created_at desc);

-- ============ helper: current tenant ============
create or replace function current_tenant_id()
returns uuid language sql stable security definer set search_path = public as $$
  select tenant_id from profiles where id = auth.uid()
$$;

create or replace function current_role_name()
returns text language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid()
$$;

-- ============ RLS ============
do $$
declare t text;
begin
  foreach t in array array[
    'tenants','profiles','clients','campaigns','keywords','media','media_contacts',
    'asp_master','serp_snapshots','serp_entries','article_listings','outreach_targets',
    'templates','message_drafts','send_attempts','replies','placements','reports','audit_logs'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- tenants: readable by members
drop policy if exists tenants_rw on tenants;
create policy tenants_rw on tenants for all to authenticated
  using (id = current_tenant_id()) with check (id = current_tenant_id());

drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select to authenticated
  using (tenant_id = current_tenant_id());
drop policy if exists profiles_self_update on profiles;
create policy profiles_self_update on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

do $$
declare t text;
begin
  foreach t in array array[
    'clients','campaigns','keywords','media','media_contacts','asp_master',
    'serp_snapshots','serp_entries','article_listings','outreach_targets',
    'templates','message_drafts','send_attempts','replies','placements','reports','audit_logs'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_rw', t);
    execute format(
      'create policy %I on %I for all to authenticated using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id())',
      t || '_rw', t);
  end loop;
end $$;

-- ============ auto profile on signup ============
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  select id into tid from tenants order by created_at limit 1;
  if tid is null then
    insert into tenants(name) values ('アドレクス') returning id into tid;
  end if;
  insert into profiles(id, tenant_id, full_name, role, sender_name)
  values (new.id, tid, coalesce(new.raw_user_meta_data->>'full_name',''), 'operator',
          coalesce(new.raw_user_meta_data->>'full_name',''))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function handle_new_user();

-- ============ collection jobs（収集センター：収集ジョブの状態管理） ============
create table if not exists collection_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  keyword_id uuid not null references keywords(id) on delete cascade,
  status text not null default 'pending', -- pending | running | done | error
  source text not null default 'ai_web_search',
  found_count int not null default 0,
  ranking_count int not null default 0,
  media_new int not null default 0,
  error_detail text not null default '',
  snapshot_id uuid references serp_snapshots(id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_cjobs_tenant_created on collection_jobs(tenant_id, created_at desc);
create index if not exists idx_cjobs_keyword on collection_jobs(keyword_id);

alter table collection_jobs enable row level security;
drop policy if exists collection_jobs_rw on collection_jobs;
create policy collection_jobs_rw on collection_jobs for all to authenticated
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
