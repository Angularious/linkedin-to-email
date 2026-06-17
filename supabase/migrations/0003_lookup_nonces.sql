-- LinkedIn → Email — single-use continuation nonces for the phased lookup.
-- Run AFTER 0002.
--
-- The lookup is now 3 separate HTTP calls (Tier 1 → Bytemine → ContactOut), each
-- its own serverless function with a full ~10s budget, so slow providers no
-- longer have to share one 10s window. Phase 1 does the bot check + rate limit
-- and hands the client a signed, single-use token; phases 2/3 redeem it here so a
-- token can't be replayed to trigger repeat paid calls (esp. the $0.33 ContactOut).
create table if not exists lookup_nonces (
  nonce uuid primary key,
  created_at timestamptz default now()
);
create index if not exists lookup_nonces_created_at_idx on lookup_nonces (created_at);
alter table lookup_nonces enable row level security;

-- Atomically claim a nonce: true the first time, false on any replay.
create or replace function consume_nonce(p_nonce uuid) returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
begin
  insert into lookup_nonces (nonce) values (p_nonce);
  return true;
exception when unique_violation then
  return false;
end;
$$;
