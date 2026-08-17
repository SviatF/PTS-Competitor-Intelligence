create extension if not exists pgcrypto;

create table if not exists public.telegram_workspaces (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null unique,
  chat_title text,
  project_name text,
  own_url text,
  geo text not null default 'UA',
  monitoring_enabled boolean not null default true,
  scan_interval_minutes integer not null default 30 check (scan_interval_minutes between 15 and 1440),
  setup_step text not null default 'awaiting_project_name',
  setup_complete boolean not null default false,
  created_by_user_id bigint,
  scan_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.competitors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.telegram_workspaces(id) on delete cascade,
  name text,
  source_url text not null,
  source_type text not null default 'instagram',
  query text,
  advertiser_pattern text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, source_url)
);

create table if not exists public.monitored_ads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.telegram_workspaces(id) on delete cascade,
  competitor_id uuid not null references public.competitors(id) on delete cascade,
  source text not null default 'META',
  library_id text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','STOPPED','REACTIVATED')),
  format text,
  advertiser text,
  cta text,
  destination_type text,
  primary_text text,
  landing_url text,
  creative_url text,
  started_at_text text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  missing_checks integer not null default 0,
  stopped_at timestamptz,
  reactivated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, source, library_id)
);

create index if not exists idx_competitors_workspace_active on public.competitors(workspace_id, is_active);
create index if not exists idx_ads_competitor_status on public.monitored_ads(competitor_id, status);
create index if not exists idx_ads_last_seen on public.monitored_ads(last_seen_at);

alter table public.telegram_workspaces enable row level security;
alter table public.competitors enable row level security;
alter table public.monitored_ads enable row level security;
