-- LinkedIn → Email — rate limiting + global spend cap
-- Run this in the Supabase SQL editor.

-- ── attempts: one row per lookup, keyed by hashed identity (IP only) ──
create table if not exists attempts (
  id uuid default gen_random_uuid() primary key,
  user_hash text not null,
  created_at timestamptz default now()
);
create index if not exists attempts_user_hash_created_at_idx
  on attempts (user_hash, created_at);

alter table attempts enable row level security;

-- ── spend_log: one row per request, tracks credits we spent (in cents) ──
-- Lets us enforce a hard global daily budget so the demo can never drain
-- our Orthogonal credits, no matter how the per-user limit is bypassed.
create table if not exists spend_log (
  id uuid default gen_random_uuid() primary key,
  cost_cents int not null,
  providers text,
  created_at timestamptz default now()
);
create index if not exists spend_log_created_at_idx on spend_log (created_at);

alter table spend_log enable row level security;

-- ── Atomic rate-limit check ──
-- Serializes concurrent requests for the same identity with an advisory
-- lock, so a burst of parallel calls can't all slip past the count check
-- (the classic check-then-insert race). Returns the post-insert count, or
-- -1 if the caller is already at/over the limit.
create or replace function check_and_log_attempt(
  p_identity text,
  p_limit int,
  p_window_hours int
) returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  current_count int;
begin
  -- Serialize per identity for the duration of this transaction.
  perform pg_advisory_xact_lock(hashtext(p_identity));

  select count(*) into current_count
  from attempts
  where user_hash = p_identity
    and created_at > now() - make_interval(hours => p_window_hours);

  if current_count >= p_limit then
    return -1;
  end if;

  insert into attempts (user_hash) values (p_identity);
  return current_count + 1;
end;
$$;

-- ── Recent spend in cents over a rolling window ──
create or replace function recent_spend_cents(p_window_hours int)
returns int
language sql
set search_path = public, pg_temp
as $$
  select coalesce(sum(cost_cents), 0)::int
  from spend_log
  where created_at > now() - make_interval(hours => p_window_hours);
$$;
