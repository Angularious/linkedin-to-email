# LinkedIn → Email

Public demo for Orthogonal: paste a LinkedIn profile URL, get the work email.
Free, no login. Top-of-funnel marketing — it spends real Orthogonal credits,
so abuse/cost protection matters.

## Stack
- Next.js 14 (App Router), deployed on Vercel
- Supabase (Postgres) for rate limiting + spend tracking
- Orthogonal REST API (`https://api.orthogonal.com/v1/run`) for the lookups.
  Providers: Ocean.io, Aviato, Apollo (cheap tier), Bytemine, ContactOut.
- Hand-drawn UI via rough.js + Indie Flower font (inline styles)

## Lookup pipeline (`app/api/lookup/route.ts`)
1. Clean + validate the LinkedIn URL (regex → canonical `/in/<slug>`)
2. Rate limit: per-IP ceiling + per-visitor quota (reject with `rate_limited`)
3. Atomic budget *reservation* — books worst-case cost up front; `at_capacity` if
   the daily cap is exhausted
4. **Tier 1 — Ocean.io ∥ Aviato ∥ Apollo in parallel** ($0.01 each). Apollo and
   Ocean also return profile data (incl. photo). Ocean takes the bare handle.
5. **Tier 2 — Bytemine** ($0.03) only if Tier 1 misses. Also backfills profile.
6. **Tier 3 — ContactOut** ($0.33), last resort — work emails preferred.
7. Reconcile the reservation to actual spend; return `{ emails, profile, verified }`
   / `not_found` / `error`

Worst-case cost ~$0.36, but expected cost is low: three independent $0.01 sources
resolve most profiles before Bytemine/ContactOut are ever paid for. Per-call
timeouts (3s + 2.5s + 3s) sum under the 10s Hobby cap.

Provider response shapes are unwrapped from Orthogonal's `{ data: ... }` envelope.
GET endpoints (Aviato, ContactOut) pass params as `query`; POST (Ocean, Apollo,
Bytemine) as `body`. Email shapes: Aviato `emails[].{email,type}` (work first),
Ocean `people[0].email(.address)`, Bytemine flat `work_email`/`email`.

## Profile enrichment (free — same paid calls)
The response also returns `profile` (merged field-by-field across providers via
`mergeProfiles` — Apollo photo, Ocean company card, etc.) and a `verified` flag.
`verified` is true only when the *displayed* email (`emails[0]`) carries a real
deliverability signal — Apollo `email_status === 'verified'` (common path) or
Bytemine `email_finder.smtp_result === 'valid'`/`confidence === 'high'` (fallback).
The UI shows a "✓ verified" badge on the primary email plus location and a
company line (logo · industry · size) in the "more info" dropdown.

**Privacy decision (deliberate):** phone numbers, salary, and age all come back in
these payloads but are intentionally NOT surfaced. Personal emails ARE returned
(as secondary results in the "more info" dropdown) — many profiles have no
discoverable work email, and returning *an* email beats returning nothing for a
demo whose whole job is "paste a URL, get an email." Phone/salary/age remain a
natural "sign up to unlock" hook for the orthogonal.com CTAs.

## Protection model (no Cloudflare)
- **Bot detection** — Vercel BotID ('basic' free tier) guards POST `/api/lookup`.
  `withBotId` in next.config, `<BotIdClient>` in the layout, `checkBotId()` in the
  route right after URL validation (before any DB/paid work; 403 if flagged).
  No-ops in local dev. Upgrade path: deepAnalysis check level (requires Pro).
- **Rate limit — two buckets, both must have room.** Identity = signed httpOnly
  cookie (`middleware.ts`) so distinct people on a shared IP each get a quota
  (`RATE_LIMIT`, 3/24h). Because anyone can mint a fresh cookie, a per-IP ceiling
  (`IP_RATE_LIMIT`, 30/24h) is enforced in parallel and can't be escaped by cookie
  rotation; cookieless clients collapse to a single strict IP bucket. IP comes
  from `request.ip` / `x-real-ip` only — NOT the spoofable first `X-Forwarded-For`
  hop. Atomic via `check_and_log_attempt` (advisory lock kills the count→insert
  race).
- **Global spend cap — concurrency-safe.** `reserve_spend` books each lookup's
  worst-case cost (`MAX_COST_CENTS`) under an advisory lock *before* any provider
  call, then `reconcile_spend` corrects it to the real amount afterward. This
  closes the TOCTOU race where bursting requests could all pass a plain pre-check
  and collectively overshoot the cap. `DAILY_BUDGET_CENTS` default $30/24h. This
  is the real money backstop. Trade-off: reserving the max can transiently show
  `at_capacity` during a heavy burst (~77 in-flight lookups) even when actual
  spend is low; it self-heals as reservations reconcile within seconds.
- Rate-limit and budget checks **fail closed** on any Supabase error.

## Env vars
Required: `ORTHOGONAL_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
Optional: `DAILY_BUDGET_CENTS` (default 3000 = $30), `IDENTITY_SECRET` (falls back
to the service role key), `NEXT_PUBLIC_SITE_URL` (OG/social previews)
NOTE: if `DAILY_BUDGET_CENTS` is set in the Vercel dashboard it overrides the code
default — update it there to change the cap in prod.

## Setup
Run the migrations in `supabase/migrations/` in order in the Supabase SQL editor:
`0001_rate_limit_and_budget.sql`, then `0002_budget_reservation.sql`. Without 0002
the reservation RPCs are missing and every lookup fails closed.

## Status
Live at `getemailfromlinkedin.vercel.app`. Cloudflare Turnstile removed; Vercel
BotID (basic) is the bot gate. Spend cap is reservation-based (concurrency-safe,
$30/day) and rate limiting enforces a cookie-proof per-IP ceiling on a trusted IP.

## Possible future hardening (not urgent)
- **Vercel WAF rate-limit rule** on `/api/lookup` — edge throttling by IP before
  the function runs. Dashboard-only, but requires the Pro plan.
- **BotID deepAnalysis** check level — stronger detection, requires Pro.
- **Attack Challenge Mode** — emergency toggle (Firewall tab) if actively hammered.
