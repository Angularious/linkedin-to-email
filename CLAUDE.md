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

## Lookup pipeline (`app/api/lookup/route.ts` — phased)
The lookup is **3 separate HTTP calls** (`{ url, phase, token }`), the client
(`LinkedInForm`) driving each only on a miss. Each phase is its own serverless
invocation with its own 10s Vercel limit, so a slow provider doesn't have to
share one 10s window — that cramming was aborting live calls. Per phase:
- **Phase 1** — clean/validate URL → bot check + rate limit (the only quota
  consumer) → reserve budget → **Ocean.io ∥ Aviato ∥ Apollo** ($0.01 each, ~8s
  each). Apollo/Ocean also return the profile card. Hit → done.
- **Phase 2** — verify single-use token → reserve → **Bytemine** ($0.03).
- **Phase 3** — verify single-use token → reserve → **ContactOut** ($0.33).

On a miss, a phase returns `{ continue, phase, token, profile }`; the client
redeems `token` on the next call and accumulates `profile` across phases. A hit
returns `{ emails, profile, verified }`; terminal states are `not_found` /
`at_capacity` / `rate_limited` / `invalid` / `error`.

Worst-case cost ~$0.36, but expected cost is low: three $0.01 sources resolve most
profiles before Bytemine/ContactOut are paid for. Full-miss wall-clock is up to
~3×10s, surfaced via "checking deeper / premium sources…" messaging.

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
- **Bot detection** — Vercel BotID ('basic' free tier) guards POST `/api/lookup`
  at **phase 1**. `withBotId` in next.config, `<BotIdClient>` in the layout,
  `checkBotId()` in the route (before any DB/paid work; 403 if flagged). No-ops in
  local dev. Upgrade path: deepAnalysis check level (requires Pro).
- **Rate limit — two buckets, both must have room — consumed once per lookup at
  phase 1.** Identity = signed httpOnly cookie (`middleware.ts`) so distinct
  people on a shared IP each get a quota (`RATE_LIMIT`, 3/24h). Because anyone can
  mint a fresh cookie, a per-IP ceiling (`IP_RATE_LIMIT`, 30/24h) is enforced in
  parallel and can't be escaped by cookie rotation; cookieless clients collapse to
  a single strict IP bucket. IP comes from `request.ip` / `x-real-ip` only — NOT
  the spoofable first `X-Forwarded-For` hop. Atomic via `check_and_log_attempt`.
- **Phased continuation tokens.** Since phases 2/3 skip the bot/rate-limit gate,
  phase 1 issues a **single-use, URL-bound, short-lived** token (`signLookupToken`,
  HMAC over `nonce|expiry|url`); phases 2/3 verify it and redeem the nonce via
  `consume_nonce` (unique-insert → false on replay). So one rate-limited phase-1
  yields at most one Bytemine + one ContactOut call — a token can't be replayed to
  hammer the paid tiers, and 2/3 can't be called directly without a valid token.
- **Global spend cap — concurrency-safe, per phase.** Each phase calls
  `reserve_spend` (books its tier's worst-case cost under an advisory lock *before*
  the provider call) then `reconcile_spend` (corrects to the real amount). Closes
  the TOCTOU race where bursting requests overshoot the cap. `DAILY_BUDGET_CENTS`
  default $30/24h — the real money backstop.
- Rate-limit and budget checks **fail closed** on any Supabase error.

## Env vars
Required: `ORTHOGONAL_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
Optional: `DAILY_BUDGET_CENTS` (default 3000 = $30), `IDENTITY_SECRET` (falls back
to the service role key), `NEXT_PUBLIC_SITE_URL` (OG/social previews)
NOTE: if `DAILY_BUDGET_CENTS` is set in the Vercel dashboard it overrides the code
default — update it there to change the cap in prod.

## Setup
Run the migrations in `supabase/migrations/` in order in the Supabase SQL editor:
`0001_rate_limit_and_budget.sql`, `0002_budget_reservation.sql`, then
`0003_lookup_nonces.sql`. Without 0002/0003 the RPCs are missing and every lookup
fails closed. `lookup_nonces` grows one row per phase-2/3 call — prune old rows by
`created_at` if it ever gets large.

## Status
Live at `getemailfromlinkedin.vercel.app`. Cloudflare Turnstile removed; Vercel
BotID (basic) is the bot gate. Lookup is split into 3 phased calls so each tier
gets a full 10s budget (fixed cold-start/slow-provider aborts). Spend cap is
reservation-based (concurrency-safe, $30/day); rate limiting enforces a
cookie-proof per-IP ceiling on a trusted IP, consumed once per lookup with
single-use tokens guarding the continuation phases.

## Possible future hardening (not urgent)
- **Vercel WAF rate-limit rule** on `/api/lookup` — edge throttling by IP before
  the function runs. Dashboard-only, but requires the Pro plan.
- **BotID deepAnalysis** check level — stronger detection, requires Pro.
- **Attack Challenge Mode** — emergency toggle (Firewall tab) if actively hammered.
