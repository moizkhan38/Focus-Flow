# Billing setup

Focus Flow sells **per organization**, not per user: one subscription covers
everyone in the org, and only an org admin can change it. That matches the data
model — projects, developers, integrations and standups are all org-scoped.

Payments run through **Clerk Billing** (Stripe underneath, managed by Clerk), so
there is no webhook handler, no customer table and no subscription table in this
repo. Clerk owns *entitlement*; we own *metering* (`org_usage`).

---

## 1. Turn on Billing in the Clerk dashboard

Clerk dashboard → **Billing Settings** → follow the guided setup, choosing
**organizations** (B2B) rather than users.

There is a CLI shortcut that does the same thing:

```bash
npx clerk@latest enable billing --for orgs
```

**Payment gateway.** Clerk offers two:

- **Clerk development gateway** — a shared test Stripe account, available on
  development instances. Pick this to build and demo: no Stripe account of your
  own, no business details, nothing to verify.
- **Your own Stripe account** — required for production. A development Stripe
  account cannot be promoted to production; production needs its own.

> Until Billing is enabled, `/api/billing/status` reports every org as `free` and
> the backend logs `[Billing] entitlement lookup failed — treating as free`. That
> is the intended failure mode: a billing outage must never hand out paid
> features.

## 2. Create the features

Clerk → **Subscription plans** → open a plan → **Features** → **Add Feature**.
(Features can also be added while creating the plan.)

The slugs must match exactly — the code gates on features, not plan names, so you
can rename or repackage plans later without touching code.

| Slug | Unlocks |
|---|---|
| `jira_sync` | Jira sync, live boards, sprints, burndown, kanban writes |
| `standup_bot` | Connecting the Slack standup bot |
| `unlimited_projects` | Removes the project cap |
| `unlimited_ai` | Removes the monthly AI generation cap |
| `members_10` | Raises the team-member cap to 10 |
| `members_25` | Raises the team-member cap to 25 |

### Tiered numbers live in the slug

Clerk features are booleans, but the team-member cap differs per tier (5 free,
10 Basic, 25 Pro). Rather than mapping plan keys to numbers in code — which would
make the plan key load-bearing, the exact coupling everything else here avoids —
**the number is carried in the slug**: `members_<n>`, or `members_unlimited`.

The highest slug an org holds wins, and one below the free allowance is ignored,
so a plan can carry several harmlessly. Adding a `members_100` tier later is
dashboard-only: no code change, no deploy.

## 3. Create the plans

Clerk → **Subscription plans** → **Plans for Organizations** tab → **Add Plan**.
The tab matters: a plan created under the user tab bills individuals and this app
will never see it.

**Do not create a "Free" plan.** Clerk enforces a $1 minimum price, so a literal
$0 plan cannot exist — and it isn't needed. An organization with no subscription
resolves to `plan: 'free'` with no features, which *is* the free tier. Creating a
cheap plan and calling it Free would charge people for the free allowances.

Two paid tiers, split so the upgrade has an obvious reason: **Basic** makes the
AI tool usable without limits; **Pro** connects it to the team's actual stack.

| Plan | Key | Price | Features |
|---|---|---|---|
| Basic | `basic` | e.g. $10/mo | `unlimited_ai`, `unlimited_projects`, `members_10` |
| Pro | `pro` | e.g. $29/mo | the above **plus** `jira_sync`, `standup_bot`, `members_25` |

Pro must list **every** slug it should grant, not just the ones Basic lacks:
entitlement is the feature set of the subscribed plan, not a cumulative ladder. A
Pro plan carrying only `jira_sync`, `standup_bot` and `members_25` would re-impose
the project and AI caps on your most expensive customers.

Give Pro `members_25` **and** leave Basic on `members_10` — do not put both slugs
on one plan expecting them to add up. They don't; the highest simply wins.

Resulting tiers:

| | Free (no subscription) | Basic | Pro |
|---|---|---|---|
| Projects | 2 | unlimited | unlimited |
| Team members | 5 | 10 | 25 |
| AI generations | 20/month | unlimited | unlimited |
| Jira sync + boards | — | — | ✓ |
| Slack standup bot | — | — | ✓ |

Leave **Publicly available** ON for both. Switched off, a plan is hidden from
`<PricingTable />` — the billing page renders empty and nobody can subscribe.

A **free trial** is safe to enable: Clerk reports trialing subscriptions with
status `trialing`, which `services/billing.js` grants alongside `active`, so a
trialing org has the full paid feature set. When the trial lapses without
payment the subscription stops being active and the org falls back to the free
tier automatically.

Further tiers are just more plans carrying the same feature slugs — no code
change. **Every plan you charge for must carry features**; a paid plan with none
would bill the customer and still apply free-tier limits.

> The plan's key is cosmetic. `isPaid` and every gate are derived from FEATURES,
> so renaming or re-keying a plan in the dashboard cannot mislabel a paying
> customer.

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

On a development instance (Clerk development gateway), subscribe with Stripe's
test card `4242 4242 4242 4242`, any future expiry, any CVC, any postcode. No
money moves.

To exercise the guards without Clerk at all, run `npm test` — it covers free vs
paid, every quota boundary, the upsert-vs-create distinction, scope-prefixed
claims, and the billing-outage fallback.

## Feature slugs are passed bare, not namespaced

`has({ feature: 'jira_sync' })` — **not** `has({ feature: 'org:jira_sync' })`.
The `org:` prefix belongs to custom permissions (`org:teams:manage`), and passing
it to a feature check silently never matches. That fails closed, which is the
worst possible direction: a customer pays and still gets refused.

The raw `fea` session claim *is* scope-prefixed (`o:` for org, `u:` for user);
`services/billing.js` strips that when reading claims directly. Both forms are
covered by tests.

## Going live

Billing on a **development** Clerk instance uses a test gateway — no real
charges. Before taking money you need a **production** Clerk instance (`pk_live`
/ `sk_live`) with Billing enabled and your own live Stripe account connected.
Plans and features must be recreated there: dashboard configuration does not
carry across instances, and a development Stripe account cannot be reused.
