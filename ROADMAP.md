# Roost — Platform Roadmap

Path from the current multi-tenant prototype (the `server` branch) to a product
you can sell to individual agents and agencies.

Roost handles two kinds of sensitive data — **agent financials** and **client
PII** (names, policy numbers, carriers). That raises the security and compliance
bar above a typical SaaS, so the roadmap is ordered by that reality:

1. **Tier 1 — Charge-blockers.** Must ship before a paying stranger touches it.
2. **Tier 2 — Scale.** Needed to go past a handful of pilot users safely.
3. **Tier 3 — Competitive polish.** Wins deals and reduces churn.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

---

## Tier 1 — Charge-blockers

- `[x]` **TLS + Secure cookies.** Session cookie now gets `Secure` when
  `ROOST_SECURE=1` / `NODE_ENV=production` (still off for localhost http dev).
  HTTPS reverse-proxy setup (Caddy/nginx) documented in `DEPLOY.md`.
- `[x]` **Login hardening.** Failed logins are rate-limited per IP+username with a
  15-minute lockout after 5 failures (429 + `Retry-After`).
- `[x]` **Password policy.** Minimum 10 chars, must include a letter and a digit;
  enforced in `createUser`/`setPassword` and the CLI generator.
- `[x]` **Tenant-isolation guarantee.** `test/tenant-isolation.test.js` proves
  unauth is blocked, each user sees only their own data, sessions map to the right
  account, bogus cookies are rejected, statements are per-user, and brute force is
  locked out. Run with `npm test`.
- `[ ]` **Encryption at rest.** Uploaded PDFs and the SQLite DB are plaintext on
  disk. Minimum: full-disk encryption on the host. Better: per-file encryption of
  stored statements with a server-held key.
- `[ ]` **Account lifecycle + email.** Self-serve (or invite-gated) signup,
  email verification, and password reset. Requires a transactional email
  provider. Admin-CLI-only provisioning does not scale to real customers.
- `[ ]` **Legal + data rights.** Privacy policy, Terms of Service, and a Data
  Processing Agreement (you process client PII on the agent's behalf). Plus
  in-product **account deletion** and **data export** (CCPA/GDPR).
- `[ ]` **Backups.** Automated, and a *tested* restore. Non-negotiable before
  anyone trusts you with their book.

## Tier 2 — Scale

- `[ ]` **Move off single-node SQLite.** `node:sqlite` is experimental and
  SQLite is single-writer/single-server. Migrate to Postgres for concurrency,
  managed backups, and read replicas. Introduce a real migration tool so schema
  can evolve without hand edits.
- `[ ]` **Parser resilience.** The carrier-specific parser is the moat and the
  main source of future support tickets. Add per-carrier test fixtures, flag
  low-confidence parses instead of silently mis-parsing, and define a repeatable
  process for onboarding a new carrier/statement layout.
- `[ ]` **Observability + ops.** Structured logging, error tracking, health
  checks, a process manager, and a deploy pipeline (CI/CD, ideally Docker).
- `[ ]` **Secrets + config management.** Pull session secret, DB URL, and email
  keys from environment/secret store, never from files in the repo.
- `[ ]` **Abuse controls on upload.** Size cap exists (25 MB); add MIME/content
  validation and per-account quotas.

## Tier 3 — Competitive polish

- `[ ]` **Billing.** Stripe plans, trials, and dunning.
- `[ ]` **Agency / team accounts.** Roost's downline model implies FMOs and
  agencies — multi-seat orgs with roles and a rolled-up view. Likely the
  best-paying segment.
- `[ ]` **Email delivery for existing features.** The weekly digest and alerts
  are built but have no transport; wire them to the email provider.
- `[ ]` **Guided onboarding.** First-upload walkthrough — the entire value
  depends on getting statements in quickly.
- `[ ]` **Admin console.** Web UI for account management to replace the CLI.

---

## Engineering notes

- **Branch model.** Platform/hosted work lands on `server` (features branched off
  it); localhost-only work stays on `main`. Shared parsing/aggregation logic is
  kept in sync between branches. See `BRANCHES.md`.
- **On "zero dependencies."** Elegant for the localhost edition; a liability as a
  platform, since it means hand-maintaining PDF parsing, XLSX generation, and
  auth primitives that mature libraries handle more reliably. Relax it
  *selectively* where a dependency de-risks correctness (parsing, crypto, DB
  driver) while keeping the footprint lean.
