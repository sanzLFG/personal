-- ============================================================
-- Personal Tracker — full schema (fork-ready, multi-user)
-- Run this ONCE on a fresh Supabase project to set up the database.
-- Contains NO personal data. Every table is isolated per user via RLS.
-- ============================================================

-- ---- profiles: one row per user (display name + preferences) ----
create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  preferences  jsonb not null default '{}'::jsonb,
  created_at   timestamptz default now()
);

-- ---- health tables (source-agnostic: whoop / manual / oura / ...) ----
create table if not exists whoop_recovery (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null default 'manual',
  date date not null,
  recovery_score int, resting_hr numeric, hrv_ms numeric, spo2 numeric, skin_temp_c numeric,
  raw jsonb, created_at timestamptz default now(),
  unique (user_id, date)
);
create table if not exists whoop_sleep (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null default 'manual',
  date date not null,
  sleep_performance int, hours_slept numeric, sleep_efficiency numeric, respiratory_rate numeric, disturbances int,
  raw jsonb, created_at timestamptz default now(),
  unique (user_id, date)
);
create table if not exists whoop_strain (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null default 'manual',
  date date not null,
  day_strain numeric, avg_hr numeric, max_hr numeric, kilojoules numeric,
  raw jsonb, created_at timestamptz default now(),
  unique (user_id, date)
);
create table if not exists whoop_workouts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null default 'manual',
  workout_id text unique,
  date date not null,
  sport text, strain numeric, avg_hr numeric, max_hr numeric, kilojoules numeric, duration_min numeric,
  raw jsonb, created_at timestamptz default now()
);

-- ---- WHOOP OAuth token store (server-side only) ----
create table if not exists whoop_tokens (
  id int primary key default 1,
  user_id uuid references auth.users(id) on delete cascade,
  access_token text, refresh_token text, expires_at timestamptz, updated_at timestamptz default now()
);

-- ---- other module tables (ready, per-user) ----
create table if not exists jobs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  external_id text, title text, company text, location text, url text,
  match_score numeric, posted_at timestamptz, seen_at timestamptz default now(),
  unique (user_id, external_id)
);
create table if not exists notes (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  category text, title text, content jsonb, created_at timestamptz default now()
);
create table if not exists recommendations (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null, focus text, recommendation text, based_on jsonb, created_at timestamptz default now()
);

-- ============================================================
-- Row Level Security: each user sees only their own rows
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','whoop_recovery','whoop_sleep','whoop_strain','whoop_workouts',
    'whoop_tokens','jobs','notes','recommendations'
  ] loop
    execute format('alter table %I enable row level security;', t);
  end loop;
end $$;

-- profiles keyed by id (= auth.uid()); everything else keyed by user_id
create policy "own_profile_select" on profiles for select to authenticated using (id = auth.uid());
create policy "own_profile_insert" on profiles for insert to authenticated with check (id = auth.uid());
create policy "own_profile_update" on profiles for update to authenticated using (id = auth.uid());

do $$
declare t text;
begin
  foreach t in array array[
    'whoop_recovery','whoop_sleep','whoop_strain','whoop_workouts','jobs','notes','recommendations'
  ] loop
    execute format('create policy "own_select" on %I for select to authenticated using (user_id = auth.uid());', t);
    execute format('create policy "own_insert" on %I for insert to authenticated with check (user_id = auth.uid());', t);
    execute format('create policy "own_update" on %I for update to authenticated using (user_id = auth.uid());', t);
    execute format('create policy "own_delete" on %I for delete to authenticated using (user_id = auth.uid());', t);
  end loop;
end $$;

-- whoop_tokens: RLS on, NO user policies (server-side secret key only).
