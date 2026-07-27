# Billing setup

Focus Flow sells **per organization**, not per user: one subscription covers
everyone in the org, and only an org admin can change it. That matches the data
model — projects, developers, integrations and standups are all org-scoped.

Payments run through **Clerk Billing** (Stripe underneath, managed by Clerk), so
there is no webhook handler, no customer table and no subscription table in this
repo. Clerk owns *entitlement*; we own *metering* (`org_usage`).

---

## 1. Turn on Billing in the Clerk dashboard

1. Clerk dashboard → **Billing** → enable it for **Organizations**.
2. Connect a Stripe account. On a **development** instance this uses Stripe
   **test mode**, so you can complete a real checkout with card `4242 4242 4242
   4242` without money moving.

> Until this is done, `/api/billing/status` reports every org as `free` and the
> backend logs `[Billing] entitlement lookup failed — treating as free`. That is
> the intended failure mode: a billing outage must never hand out paid features.

## 2. Create the features

Clerk → **Billing → Features**. The slugs must match exactly — the code gates on
features, not on plan names, so you can rename or repackage plans later without
touching code.

| Slug | Unlocks |
|---|---|
| `jira_sync` | Jira sync, live boards, sprints, burndown, kanban writes |
| `standup_bot` | Connecting the Slack standup bot |
| `unlimited_projects` | Removes the project **and** team-member caps |
| `unlimited_ai` | Removes the monthly AI generation cap |

## 3. Create the plans

Clerk → **Billing → Plans**, scoped to **Organizations**.

| Plan | Slug | Price | Features |
|---|---|---|---|
| Free | `free` | 0 | *(none)* |
| Pro | `pro` | your price | all four above |

Anything without a paid feature falls back to the free allowances below. A third
tier is just another plan with the same feature slugs — no code change.

## 4. Free-tier allowances

Enforced in `services/billing.js`, overridable per environment:

| Env var | Default | Meaning |
|---|---|---|
| `FREE_MAX_PROJECTS` | `2` | projects an org may have at once |
| `FREE_MAX_AI_GENERATIONS` | `20` | AI generations per calendar month (UTC) |
| `FREE_MAX_DEVELOPERS` | `5` | developer-roster entries |

The AI counter resets on the 1st of each month and lives in `org_usage`
(migration `008_billing_usage.sql` — run `npm run migrate`).

---

## What is enforced, and where

The React UI hides paid features, but **hiding is not enforcing** — every gated
route is one `fetch()` away. These are the server-side guards:

| Route | Guard |
|---|---|
| `POST /api/generate`, `/api/regenerate`, `/api/classify-epics` | monthly AI allowance |
| `POST /api/ai/sync-jira` | `jira_sync` |
| `GET/PUT /api/jira/*` (boards, sprints, issues, burndown) | `jira_sync` |
| `PUT /api/integrations/slack` | `standup_bot` |
| `POST /api/db/projects` | project allowance (new projects only) |
| `POST /api/db/developers` | developer allowance (new members only) |

`GET /api/jira/test`, `/api/jira/health` and `/api/jira/my-account` stay open so
an org can verify its connection before paying.

**Refusals answer `402` with `UPGRADE_REQUIRED`**, plus the `feature` to buy and
the `limit`/`used` numbers. 402 is deliberately distinct from `403` (you lack the
role) and `412` (the provider isn't connected) — the frontend sends the user to
the pricing page, the org settings, or Integrations respectively, and collapsing
them would misdirect people.

Quota is checked **before** the work and recorded **after** it succeeds, so a
failed generation doesn't consume an allowance the user got nothing for.

## Caching, and why upgrades appear immediately

Entitlement is cached for 60 seconds per org. Session tokens are also only
refreshed periodically, so a just-completed checkout could otherwise look like it
did nothing. Two things prevent that:

- `services/billing.js` falls back to Clerk's Billing API when the session token
  carries no billing claims.
- The billing page calls `POST /api/billing/refresh` on return from checkout,
  which drops the cached entitlement for that org.

## Testing a paid org without paying

On a development instance, complete a checkout with Stripe's test card
`4242 4242 4242 4242`, any future expiry, any CVC. To exercise the guards without
Clerk at all, run the suite: `npm test` covers free/paid, every quota boundary,
the upsert-vs-create distinction, and the billing-outage fallback.

## Going live

Billing on a **development** Clerk instance is Stripe test mode — no real
charges. Before taking money you need a **production** Clerk instance (`pk_live`
/ `sk_live`) with Billing enabled and a live Stripe account connected. The plans
and features must be recreated there; dashboard configuration does not carry
across instances.
