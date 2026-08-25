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

-- 陣取り表のヘッダー（案件カルテ）で使う項目。既存プロジェクトにも足すため alter で追記する
alter table campaigns add column if not exists genre         text not null default '';
alter table campaigns add column if not exists reference_url text not null default '';
alter table campaigns add column if not exists draft_url     text not null default '';
-- brief は案件固有の長文（理想のユーザー像・NG層・検索意図・推奨KW 等）を自由記述で持つ
alter table campaigns add column if not exists brief         text not null default '';

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

-- ============ documents（案件資料・媒体資料の取り込み） ============
-- ファイル本体は Storage の documents バケットに置き、この表はメタと抽出結果を持つ
create table if not exists documents (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  kind          text not null,                     -- campaign_brief | media_kit
  campaign_id   uuid references campaigns(id) on delete cascade,
  media_id      uuid references media(id) on delete cascade,
  file_name     text not null,
  storage_path  text not null,
  mime_type     text not null default '',
  byte_size     int  not null default 0,
  status        text not null default 'uploaded',  -- uploaded | extracting | extracted | error
  -- 系統ごとに項目が違うので jsonb。再抽出時にファイルを再アップせずに済む
  extracted     jsonb,
  extract_error text not null default '',
  uploaded_by   uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_documents_campaign on documents(campaign_id, created_at desc);
create index if not exists idx_documents_media    on documents(media_id, created_at desc);

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
    'templates','message_drafts','send_attempts','replies','placements','reports','audit_logs',
    'documents'
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
    'templates','message_drafts','send_attempts','replies','placements','reports','audit_logs',
    'documents'
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

-- ============ storage: documents バケット（非公開） ============
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- パスの先頭セグメントを tenant_id にしてテナント間を隔離する
drop policy if exists documents_objects_rw on storage.objects;
create policy documents_objects_rw on storage.objects for all to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = current_tenant_id()::text
  )
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = current_tenant_id()::text
  );

-- ============ 検索ボリューム / KW候補 / スポンサー広告（DataForSEO 連携） ============

-- キーワードごとの月間検索ボリューム。DataForSEO（Google 広告のキーワードプランナー由来）で埋める
alter table keywords add column if not exists search_volume     int;
alter table keywords add column if not exists cpc               numeric;
alter table keywords add column if not exists competition       text not null default '';
alter table keywords add column if not exists volume_source     text not null default '';  -- dataforseo
alter table keywords add column if not exists volume_updated_at timestamptz;

-- 検索結果の区分。paid = スポンサー広告（赤枠） / organic = オーガニック検索（青枠）
alter table serp_entries add column if not exists result_type text not null default 'organic';
create index if not exists idx_entries_result_type on serp_entries(snapshot_id, result_type);

-- 収集ジョブでスポンサー広告を何件拾ったか（found_count の内数）
alter table collection_jobs add column if not exists paid_count int not null default 0;

-- KW候補（採用前の提案。採用すると keywords へ移す）
create table if not exists keyword_suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  keyword text not null,
  search_volume int,
  cpc numeric,
  competition text not null default '',
  source text not null default 'ai',   -- ai | dataforseo
  reason text not null default '',
  status text not null default 'suggested', -- suggested | adopted | dismissed
  created_at timestamptz not null default now()
);
create unique index if not exists uq_kwsug_campaign_keyword on keyword_suggestions(campaign_id, keyword);
create index if not exists idx_kwsug_campaign on keyword_suggestions(campaign_id, status, search_volume desc nulls last);

alter table keyword_suggestions enable row level security;
drop policy if exists keyword_suggestions_rw on keyword_suggestions;
create policy keyword_suggestions_rw on keyword_suggestions for all to authenticated
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());

-- ============ 本文読取の重複排除 ============
-- 記事本文の読取（runEnrichEntry）はこのアプリで最も高い処理なので、
-- 「いつ読んだか」を持たせて同一案件・同一URL・直近の結果を引き写せるようにする。
alter table serp_entries add column if not exists enriched_at timestamptz;
-- 再利用の検索条件（記事URL × 読取済み）に効かせる
create index if not exists idx_entries_reuse on serp_entries(article_url, enriched_at desc nulls last);

-- ============ AI利用料の計測 ============
-- 「1レポート（＝1案件）を作るのにいくらかかったか」を画面に出すための実績。
-- 単価は変わるので、記録時点の単価で金額に変換して凍結する（cost_usd）。
create table if not exists ai_usage (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete cascade,
  keyword_id uuid references keywords(id) on delete set null,
  kind text not null,                      -- enrich | collect_search | collect_judge | ...
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  web_searches int not null default 0,     -- Web検索ツールはトークンと別建ての従量
  cost_usd numeric(12,6) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_ai_usage_campaign on ai_usage(campaign_id, created_at desc);
create index if not exists idx_ai_usage_tenant on ai_usage(tenant_id, created_at desc);

alter table ai_usage enable row level security;
drop policy if exists ai_usage_rw on ai_usage;
create policy ai_usage_rw on ai_usage for all to authenticated
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());

-- 集計をDB側で済ませる。1案件で数千行になるので、明細を全部引かずに済ませたい。
-- security_invoker = on で ai_usage の RLS がそのまま効く。
create or replace view ai_usage_by_kind
with (security_invoker = on) as
  select tenant_id, campaign_id, kind,
         count(*)::bigint            as calls,
         sum(input_tokens)::bigint   as input_tokens,
         sum(output_tokens)::bigint  as output_tokens,
         sum(web_searches)::bigint   as web_searches,
         sum(cost_usd)::numeric      as cost_usd,
         max(created_at)             as last_at
  from ai_usage
  group by tenant_id, campaign_id, kind;

create or replace view ai_usage_by_keyword
with (security_invoker = on) as
  select u.tenant_id, u.campaign_id, u.keyword_id, k.keyword,
         count(*)::bigint       as calls,
         sum(u.cost_usd)::numeric as cost_usd
  from ai_usage u
  join keywords k on k.id = u.keyword_id
  group by u.tenant_id, u.campaign_id, u.keyword_id, k.keyword;
