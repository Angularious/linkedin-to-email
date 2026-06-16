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
2. Global spend-cap check (reject with `at_capacity` if over budget)
3. Atomic per-visitor rate limit (reject with `rate_limited` if over)
4. **Tier 1 — Ocean.io ∥ Aviato ∥ Apollo in parallel** ($0.01 each). Apollo and
   Ocean also return profile data (incl. photo). Ocean takes the bare handle.
5. **Tier 2 — Bytemine** ($0.03) only if Tier 1 misses. Also backfills profile.
6. **Tier 3 — ContactOut** ($0.33), last resort — work emails preferred.
7. Record spend, return `{ emails, profile }` / `not_found` / `error`

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

**Privacy decision (deliberate):** phone numbers, personal emails, salary, and age
all come back in these payloads but are intentionally NOT surfaced — this is a
public, no-login *work*-email finder. They're a natural "sign up to unlock" hook
for the existing orthogonal.com CTAs, not free anonymous data.

## Protection model (4 layers, no Cloudflare)
- **Bot detection** — Vercel BotID ('basic' free tier) guards POST `/api/lookup`.
  `withBotId` in next.config, `<BotIdClient>` in the layout, `checkBotId()` in the
  route right after URL validation (before any DB/paid work; 403 if flagged).
  No-ops in local dev. Upgrade path: deepAnalysis check level (requires Pro).
- **Per-visitor rate limit** — 3 lookups / rolling 24h. Identity = signed httpOnly
  cookie issued by `middleware.ts` on page load, falling back to IP for cookieless
  clients. Lets distinct people on a shared IP (campus/office WiFi) each get their
  own quota. Atomic via the `check_and_log_attempt` RPC (advisory lock kills the
  check-then-insert race).
- **Global spend cap** — hard ceiling (`DAILY_BUDGET_CENTS`, default $25/24h) via
  the `spend_log` table + `recent_spend_cents` RPC. This is the real backstop:
  bounds worst-case cost no matter how the per-user limit is bypassed.
- Rate-limit and budget checks **fail closed** on any Supabase error.

## Env vars
Required: `ORTHOGONAL_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
Optional: `DAILY_BUDGET_CENTS` (default 2500), `IDENTITY_SECRET` (falls back to the
service role key), `NEXT_PUBLIC_SITE_URL` (OG/social previews)

## Setup
Run `supabase/migrations/0001_rate_limit_and_budget.sql` in the Supabase SQL editor.
Without it, every lookup fails closed.

## Status
Live and working at `getemailfromlinkedin.vercel.app`. Supabase migration run,
env vars set. Cloudflare Turnstile fully removed. Vercel BotID (basic) added as
the bot gate. All four protection layers in place — no known open items.

## Possible future hardening (not urgent)
- **Vercel WAF rate-limit rule** on `/api/lookup` — edge throttling by IP before
  the function runs. Dashboard-only, but requires the Pro plan.
- **BotID deepAnalysis** check level — stronger detection, requires Pro.
- **Attack Challenge Mode** — emergency toggle (Firewall tab) if actively hammered.
