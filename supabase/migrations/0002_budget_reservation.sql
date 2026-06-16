-- LinkedIn → Email — concurrency-safe budget reservation
-- Run this in the Supabase SQL editor AFTER 0001.
--
-- 0001 checked recent spend, then logged the cost only after the (multi-second)
-- provider calls finished. Under a burst, many requests could all read the same
-- pre-spend total and slip past the cap before any of them logged a cent — so
-- real spend could overshoot the daily budget by an amount bounded only by
-- concurrency. These two functions close that race: every lookup books its
-- worst-case cost up front under a lock, then reconciles to the real amount.

-- Atomically reserve budget headroom. Under an advisory lock (serializing the
-- read-then-insert across concurrent requests), sum recent spend; if still under
-- budget, insert a reservation row for the maximum a single lookup can cost and
-- return its id. Returns null when the budget is already exhausted.
create or replace function reserve_spend(
  p_window_hours int,
  p_budget_cents int,
  p_reserve_cents int
) returns uuid
language plpgsql
as $$
declare
  spent int;
  rid uuid;
begin
  perform pg_advisory_xact_lock(hashtext('spend_log'));

  select coalesce(sum(cost_cents), 0)::int into spent
  from spend_log
  where created_at > now() - make_interval(hours => p_window_hours);

  if spent >= p_budget_cents then
    return null;
  end if;

  insert into spend_log (cost_cents, providers)
  values (p_reserve_cents, 'reserved')
  returning id into rid;

  return rid;
end;
$$;

-- Reconcile a reservation to the amount actually spent (0 if nothing was spent).
create or replace function reconcile_spend(
  p_id uuid,
  p_cost_cents int,
  p_providers text
) returns void
language sql
as $$
  update spend_log
  set cost_cents = p_cost_cents, providers = p_providers
  where id = p_id;
$$;
