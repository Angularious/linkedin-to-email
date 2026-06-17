# LinkedIn → Email

Public demo for Orthogonal: paste a LinkedIn profile URL, get the work email.
Free, no login. Top-of-funnel marketing — it spends real Orthogonal credits,
so abuse/cost protection matters.

## Stack
- Next.js 14 (App Router), deployed on Vercel
- Supabase (Postgres) for rate limiting + spend tracking
- Orthogonal REST API (`https://api.orthogonal.com/v1/run`) for the lookups.
  Providers: Ocean.io, Aviato, Apollo, Bytemine (phase 1, parallel), ContactOut (phase 2).
- Hand-drawn UI via rough.js + Indie Flower font (inline styles)

## Lookup pipeline (`app/api/lookup/route.ts` — phased)
The lookup is **2 separate HTTP calls** (`{ url, phase, token }`), the client
(`LinkedInForm`) driving phase 2 only on a miss. Each phase is its own serverless
invocation with its own 10s Vercel limit, so a slow provider doesn't have to
share one 10s window — that cramming was aborting live calls. Per phase:
- **Phase 1** — clean/validate URL → bot check + rate limit (the only quota
  consumer) → reserve budget → **Ocean.io ∥ Aviato ∥ Apollo ∥ Bytemine** in
  parallel (~$0.06, ~8s). Apollo/Ocean/Bytemine also return the profile card.
  Bytemine runs here (not as a fallback) to raise hit quality cheaply. Hit → done.
- **Phase 2** — verify single-use token → reserve → **ContactOut** ($0.33),
  the expensive last resort, only when phase 1 finds nothing.

On a miss, a phase returns `{ continue, phase, token, profile }`; the client
redeems `token` on the next call and accumulates `profile` across phases. A hit
returns `{ emails, profile, verified }`; terminal states are `not_found` /
`at_capacity` / `rate_limited` / `invalid` / `error`.

A provider HTTP **404 = "no record for this profile"** — a clean miss, not a
failure and not billable. `callOrthogonal` flags it as `notFound`, so it counts
as "responded" (→ `not_found`, never a 502) but is charged $0. Only true errors
(timeout / 5xx / network) leave a phase with no responder and yield `error`/502.

Worst-case cost ~$0.39 (phase 1 ~$0.06 + ContactOut $0.33); expected cost ~$0.06,
since the four parallel phase-1 providers resolve most profiles before ContactOut
is ever paid for. Full-miss wall-clock is up to ~2×10s, surfaced via a "checking
deeper sources…" message.

Provider response shapes are unwrapped from Orthogonal's `{ data: ... }` envelope.
GET endpoints (Aviato, ContactOut) pass params as `query`; POST (Ocean, Apollo,
Bytemine) as `body`. Email shapes: Aviato `emails[].{email,type}` (work first),
Ocean `people[0].email(.address)`, Bytemine flat `work_email`/`email`.

## Profile enrichment (free — same paid calls)
The response also returns `profile` (merged field-by-field across providers via
`mergeProfiles` — Apollo photo, Ocean company card, etc.) and a `verified` flag.
`verified` is true only when the *displayed* email (`emails[0]`) carries a real
deliverability signal — Apollo `email_status === 'verified'` or Bytemine
`email_finder.smtp_result === 'valid'`/`confidence === 'high'` (both run in phase 1).
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
- **Rate limit — checked at phase 1.** Two buckets:
  - **Per-visitor quota** (`RATE_LIMIT`, 5/24h), keyed on the signed httpOnly
    cookie (`middleware.ts`) so distinct people on a shared IP each get their own.
    Counts **only successful lookups** — a "not found" never burns a free search.
    The success row is written in `attempts` (key `v:<id>`) only when an email is
    actually returned (in whichever phase finds it); the phase-1 check is a
    read-only count of prior successes.
  - **Per-IP ceiling** (`IP_RATE_LIMIT`, 30/24h, atomic `check_and_log_attempt`)
    counts **every** attempt incl. misses. This is the cost backstop and the real
    abuse bound — it's what makes "misses don't count" safe, since a flood of
    not-found lookups still spends money. Cookie rotation can't escape it.
    Cookieless clients have no per-visitor quota → a single strict IP bucket at
    `RATE_LIMIT` (every attempt counts). IP comes from `request.ip` / `x-real-ip`
    only — NOT the spoofable first `X-Forwarded-For` hop.
- **Phased continuation token.** Since phase 2 skips the bot/rate-limit gate,
  phase 1 issues a **single-use, URL-bound, short-lived** token (`signLookupToken`,
  HMAC over `nonce|expiry|url`); phase 2 verifies it and redeems the nonce via
  `consume_nonce` (unique-insert → false on replay). So one rate-limited phase-1
  yields at most one ContactOut call — the token can't be replayed to hammer the
  $0.33 tier, and phase 2 can't be called directly without a valid token.
- **Global spend cap — concurrency-safe, per phase.** Each phase calls
  `reserve_spend` (books its tier's worst-case cost under an advisory lock *before*
  the provider call) then `reconcile_spend` (corrects to the real amount). Closes
  the TOCTOU race where bursting requests overshoot the cap. `DAILY_BUDGET_CENTS`
  defaults to $30/24h in code; **prod is set to $35** via the Vercel env var — the
  real money backstop.
- Rate-limit and budget checks **fail closed** on any Supabase error.

## Env vars
Required: `ORTHOGONAL_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
Optional: `DAILY_BUDGET_CENTS` (code default 3000 = $30; **prod set to 3500 = $35**),
`IDENTITY_SECRET` (falls back to the service role key), `NEXT_PUBLIC_SITE_URL`
(OG/social previews)
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
BotID (basic) is the bot gate. Lookup is split into 2 phased calls (phase 1: four
providers in parallel; phase 2: ContactOut) so each gets a full 10s budget (fixed
the cold-start/slow-provider aborts). Spend cap is reservation-based
(concurrency-safe, $35/day in prod). Per-visitor quota is 5 *successful*
lookups/day, with a cookie-proof per-IP ceiling on a trusted IP and single-use
tokens guarding the ContactOut phase.

## Possible future hardening
- **Move off Vercel Hobby → Pro (top item before scaling).** Hobby is
  non-commercial-use only; this lead-gen demo is a ToS violation that risks
  suspension. Won't bite at ~100 users, but fix it before a bigger push. Pro also
  unlocks WAF rate-limiting and 300s functions.
- **Guard `DAILY_BUDGET_CENTS`** — a non-numeric env value makes `Number()` → NaN,
  which silently disables the cap. Validate it's a positive finite number.
- **Pin the Vercel function region** near the Supabase region (no `vercel.json`
  today) so the ~4–6 DB round-trips/lookup don't pay cross-region latency.
- **Keep-warm cron** — Supabase free pauses after 7 days idle; a periodic ping
  avoids a cold "site is down" on the next visit.
- **TTL-cleanup** `attempts` / `spend_log` / `lookup_nonces` for a long-lived demo
  (they grow one row per attempt/lookup; affects the 500 MB cap and query speed).
- **Vercel WAF rate-limit rule / BotID deepAnalysis / Attack Challenge Mode** —
  all Pro-tier edge protections.
