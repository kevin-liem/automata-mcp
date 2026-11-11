# Plan: Brevo CRM sync for hosted signups

Status: **implemented** (see "Decisions" at the end, and "Implementation notes"). Hosted
offering only. Nothing here reaches a self-hosted deployment.

## Goal

When someone signs up on the hosted deployment, a contact for them appears in
Brevo within a minute. Every contact is added to the product list. Only people
who ticked the marketing box at signup are added to the marketing list. The
contact carries enough context for onboarding and sales: who they are, when
they joined, which plan they chose, which organization they are in and with
what role, and which plan that organization is on now. Later changes (email
address, role, organization, plan) keep the contact current.

## What already exists

This was designed for when the hosted billing split was built
([ju-li/automata-mcp#75](https://github.com/ju-li/automata-mcp/pull/75) and
commit `e4aebe3`). Most of the plumbing is already there:

- **The outbox.** `app.hosted_events` is written in the same transaction as
  each account change. The `user.signed_up` and `user.email_changed` payloads
  carry the email address on purpose, because "the CRM keys contacts on it"
  (`apps/web/server/utils/hosted-events.ts`). Nothing is written on a
  self-hosted deployment.
- **Rows are retained for this consumer.** The billing consumer never deletes
  rows, and each consumer keeps its own cursor in `cloud.cursors`. A consumer
  added later "starts from the beginning of the retained backlog"
  (`apps/cloud/src/db.ts`).
- **The service it belongs in.** `apps/cloud/src/main.ts` and `docs/billing.md`
  both say the Brevo sync joins the cloud service, fed by the same outbox.
- **Ordering inside a signup.** Both signup paths (`signup.post.ts`, and
  `complete()` in `email-verification.ts`) write `user.signed_up` and then
  `org.created` + `member.joined`, or `member.joined` through
  `acceptInviteInto`, in one transaction. A batch that holds the signup
  therefore holds the membership too.

Most of this is one new consumer in `apps/cloud`. The web app changes in one
place only: the marketing-consent checkbox on signup, which nothing records
today. That part is shown and stored only in hosted mode.

## Part 1 — Marketing consent (web app, hosted mode only)

### Signup form

- `signup.vue` shows an **unticked** checkbox under the plan picker. Suggested
  label: "Send me product news and tips by email. You can unsubscribe at any
  time." It is shown only when `/api/auth/signup-policy` reports
  `billing: true` (that is, `hostedMode()`), the flag that already gates the
  plan picker and the legal links. Invited signups see it too, since they get a
  contact like everyone else.
- The box is never ticked by default, and signup never requires it.

### Server

- `signup.post.ts` accepts `marketingConsent?: boolean`. It is read **only when
  `hostedMode()`**, and is forced to false otherwise, so a self-hosted
  deployment never records consent even if a client sends the field.
- New migration (next free number, append-only):
  - `app.users.marketing_consent_at timestamptz` (NULL means not given)
  - `app.email_verifications.marketing_consent boolean NOT NULL DEFAULT false`,
    carried through verification exactly like `plan` is today
- The account is created in one of two places: `createUser` in the
  no-verification path, or `complete()` after verification. Both set
  `marketing_consent_at = now()` when consent was given, in the same
  transaction that creates the user.
- `user.signed_up` gains `marketingConsent: boolean` in its payload. This is
  allowed by the payload rules, and gives telemetry the same fact.

`marketing_consent_at` records that consent was **given at signup** and when.
It is not current subscription state. Brevo owns that: an unsubscribe there is
final, and nothing here re-adds anyone. The checkbox wording at any date is in
the git history of `signup.vue`, which together with the timestamp is the
record of what was agreed to.

Opting in later from the profile page is out of scope (see "Later").

## Part 2 — The CRM consumer (`apps/cloud`)

### Where the code goes

- **`apps/cloud/src/crm.ts`**: the only file that talks to Brevo, the way
  `billing.ts` is the only one that talks to Stripe. It uses plain `fetch`
  against `https://api.brevo.com/v3` with the `api-key` header. No SDK: we use
  a handful of endpoints, and the official SDK is a large generated client.
  It exports `upsertContacts(sql, userIds, signupFacts?)`. Both the consumer
  and the backfill call it.
- **`apps/cloud/src/outbox.ts`**: pull the cursor read and write out of the
  billing consumer into two helpers, `readCursor(sql, consumer, startAt)` and
  `advanceCursor(sql, consumer, id)`. Billing keeps `startAt: 'newest'`. The
  CRM consumer uses `'oldest'`. Billing's behaviour stays exactly as it is.
- **`apps/cloud/src/main.ts`**: a second interval next to the billing one, with
  the same 15-second period and its own `consuming` guard.

### Configuration (`config.ts`)

| Variable | Meaning |
|---|---|
| `BREVO_API_KEY` | Turns the sync on. |
| `BREVO_PRODUCT_LIST` | Numeric Brevo list id. Every contact is added to it when created. |
| `BREVO_MARKETING_LIST` | Numeric Brevo list id. A contact whose user gave marketing consent at signup is added to it when created. |
| `BREVO_API_URL` | Optional. Defaults to `https://api.brevo.com/v3`. Exists so failure modes can be tested against a local stub. |

**The first three go together**, like the four `STRIPE_*` variables:

- **None set:** no CRM consumer and no cursor row.
- **Some set, or a non-numeric list id:** the service refuses to start, naming
  the variable.
- **All three set:** the sync runs.

A key with no marketing list would silently drop consent that people gave, so
it must fail loudly rather than pass for "marketing off". `/health` gains
`crm: 'configured' | 'unconfigured'`.

**The cursor is created only when the variables are set.** A deployment that
runs the cloud service for weeks before adding them still syncs every signup
from the retained backlog on the day they arrive. That is the reason rows are
kept.

### Event = which contact to refresh; live read = what to send

This follows the rule the Stripe webhook already uses ("payload = hint, live
read = fact"). The consumer does **not** build contacts from event payloads.
Each event only says which users are affected:

| Event | Users to refresh |
|---|---|
| `user.signed_up`, `user.email_changed` | `user_id` |
| `member.joined`, `member.removed`, `member.role_changed` | `user_id` |
| `plan.changed` | every current member of `org` |
| everything else (`connection.*`, `token.*`, `usage.rollup`, `org.*`) | none; the cursor moves past them |

For each pass, the consumer gathers the affected user ids into a set, which
merges the three events of one signup into a single call. It then reads
current state from the app schema in one query:

```sql
SELECT u.id, u.email, u.name, u.created, u.marketing_consent_at,
       m.role, o.id AS org_id, o.name AS org_name, o.plan_label
FROM app.users u
LEFT JOIN app.memberships m ON m.user_id = u.id
LEFT JOIN app.organizations o ON o.id = m.org
WHERE u.id = ANY($1)
```

Why read current state instead of trusting the payload:

- **Replays and reordering are harmless.** Replaying an old
  `user.email_changed` sends today's address, not the one from the payload.
- **A pass that stopped halfway re-sends the current state.** It never sends an
  intermediate one.
- **The email in the payload becomes a fallback, not the source.** If the
  payload and the live row disagree, the live row wins.

There is one exception. The plan chosen at signup (`payload.plan`) and
`invited` are facts about the signup itself and are stored nowhere else
(`email_verifications.plan` is deleted on verify). They are read from the
`user.signed_up` payload and sent only when that event is in the batch.
Consent does not need this exception, because it now has its own column.

A user id that no longer matches a row is skipped and logged. The app has no
account deletion today, so this should not happen.

### What goes to Brevo

The contact is keyed on the **user id** as Brevo's `ext_id`, not on the email
address. That way an email change updates the same contact instead of creating
a second one.

| Brevo field | Source | Type |
|---|---|---|
| `email` | `app.users.email` | identifier |
| `ext_id` | `app.users.id` | identifier |
| `FULL_NAME` | `app.users.name`, whole, never split | text |
| `SIGNUP_DATE` | `app.users.created` | date |
| `SIGNUP_PLAN` | `user.signed_up` payload (`free` / `pro` / empty when invited) | text |
| `INVITED` | `user.signed_up` payload | boolean |
| `ORG_ID`, `ORG_NAME` | the user's organization | text |
| `ORG_ROLE` | `admin` / `member` | text |
| `PLAN` | `organizations.plan_label` (`Free`, `Pro`, `Pro (trial)`) | text |

That is the whole list. The rule from `hosted-events.ts` extends to Brevo:
never send connection kinds or counts, hosts, chat, folder or table names,
token data, usage, or anything else from `instances`. Adding a field later is
a decision recorded in this file, not a one-line change.

The service never sends `emailBlacklisted`, `smsBlacklisted` or unsubscribe
state. Unsubscribes belong to Brevo, and a re-sync must not undo one.

### The upsert, per user

1. `PUT /contacts/{userId}?identifierType=ext_id` with
   `{ attributes: { EMAIL, …the rest } }` and **no `listIds`**. This updates
   the existing contact, including its address.
2. If that returns **404**, run `POST /contacts` with
   `{ email, ext_id, attributes, listIds }`, where `listIds` is the product
   list, plus the marketing list when `marketing_consent_at` is set.
3. If the create returns a duplicate-email error, a contact for that address
   already exists without our `ext_id` (a newsletter signup, say, or an
   imported list). Claim it: `PUT /contacts/{email}?identifierType=email_id`
   with `ext_id`, the attributes, and the same `listIds` as step 2.

**Lists are set only when we create or claim a contact.** That is the moment
the user signed up and gave (or didn't give) consent. Every later update leaves
list membership alone, so:

- someone who unsubscribed from marketing is never put back by a role change
  or a plan change;
- consent is never inferred later from anything but the signup.

If a claimed contact was already blacklisted in Brevo, adding them to the
marketing list does not lift the blacklist. That is Brevo's rule and the safe
direction.

Each step is idempotent, so processing an event twice costs one extra call and
changes nothing.

> Before building this, verify these Brevo behaviours against a free account:
> how `identifierType=ext_id` behaves, whether updating `EMAIL` through
> `attributes` re-keys the contact, the exact error code for a duplicate
> email, whether `PUT` with `listIds` adds without removing other lists, and
> whether an unknown attribute name is refused or silently dropped. They come
> from Brevo's API reference, not from a test.

### Attributes and lists are checked at boot

When the variables are set, the service checks Brevo once at startup:

- It lists the contact attributes and creates any that are missing
  (`POST /contacts/attributes/normal/{name}`).
- It confirms both list ids exist (`GET /contacts/lists/{id}`).

Otherwise a typo, or an attribute nobody created in the dashboard, would mean
the data never arrives without anyone noticing. If either check fails, the CRM
consumer stays off for that process and the reason is logged. Billing is
unaffected.

### Failures

Like the `org.deleted` cancellation, this has no reconcile behind it today. A
dropped event would mean a missing contact. So:

| Brevo answer | What the consumer does |
|---|---|
| network error, 5xx, **429** | Stop the cursor before this event and retry on the next pass. On 429, wait until Brevo's rate-limit reset header before the next pass. |
| **401 / 403** | Stop the cursor and log, at most once per minute, that the key is wrong. Skipping would throw away every later event. |
| any other 4xx (for example an address Brevo rejects as invalid) | Permanent for this event. Log it with the event id, user id, status and Brevo's `code` (never the address), record it in `cloud.crm_skipped`, and move on. |

`cloud.crm_skipped (event_id, user_id, status, code, at)` lets someone replay a
skipped event by hand once its cause is fixed. It is created by
`ensureCloudSchema` like `cursors`.

Logs never contain the email address, the name or the API key, and the error
helper never echoes request bodies.

### Replicas

The billing consumer already assumes one cloud replica. Duplicate passes would
be harmless here (every call is an idempotent upsert), but the cursor update
could go backwards. If the service ever runs more than one replica, both
consumers should take a lease on their `cloud.cursors` row with a conditional
`UPDATE`, the way IMAP sync does, rather than an advisory lock held across
HTTP calls. This is not part of this change.

## Part 3 — One-off backfill for accounts from before the outbox

Accounts created before `e4aebe3` have no `user.signed_up` event, so the
consumer never sees them.

- **Command:** `pnpm cloud:crm-backfill`, a root script running
  `apps/cloud/src/crm-backfill.ts`. It uses the same environment as the
  service and refuses to run unless the three `BREVO_*` variables are set.
- **What it does:** walks `app.users` in id order, 100 per batch, and calls the
  same `upsertContacts`. It sends no signup facts (`SIGNUP_PLAN` and `INVITED`
  stay empty), since none were recorded for these accounts.
- **Lists:** it adds each new contact to the product list only. None of these
  users were ever asked for consent, so `marketing_consent_at` is NULL for all
  of them and none reach the marketing list.
- **Safe to rerun, and safe to run beside the live consumer:** every call is an
  idempotent upsert, and users who already have a contact go down the update
  path, which leaves lists alone.
- **Failures:** the same table applies. Transient errors are retried with
  backoff, a bad key stops the run, and permanent errors are recorded in
  `cloud.crm_skipped` (with a NULL `event_id`). It prints a summary: created,
  updated, skipped.
- It covers every user, not only the pre-outbox ones. That is simpler than
  working out which users have no event, and it is harmless.

Run it once, after the consumer has been deployed and `/health` reports
`crm: ready`.

## Rollout

1. ~~Add Brevo as a sub-processor in the privacy policy.~~ **Done.**
2. In Brevo, create an API key and two lists: "Product users" and "Marketing".
3. Deploy the web app with the consent migration and checkbox. From then on,
   consent is recorded even before the sync is on.
4. Set `BREVO_API_KEY`, `BREVO_PRODUCT_LIST` and `BREVO_MARKETING_LIST` on the
   cloud service on Railway and redeploy.
5. On first boot, the service checks the attributes and lists, creates the
   `crm` cursor at the oldest retained event, and works through the backlog.
   It handles 500 events per pass, so a backlog of a few thousand clears in
   minutes. Most events are `usage.rollup` and are skipped without any Brevo
   call.
6. Run `pnpm cloud:crm-backfill` once against production.
7. Check: `/health` reports `crm: ready`, Brevo's contact count matches
   `SELECT count(*) FROM app.users`, the marketing list's size matches
   `… WHERE marketing_consent_at IS NOT NULL`, and `cloud.crm_skipped` is
   empty.

## Testing

There is no test framework (see `CLAUDE.md`). `pnpm typecheck` and
`pnpm cloud:typecheck` must pass. Then test by hand:

- **Consent capture:**
  - With the box ticked and with it unticked, through both signup paths
    (with and without email verification).
  - The box is not shown when `NUXT_CLOUD_URL` is unset.
  - A self-hosted signup that posts `marketingConsent: true` anyway stores
    NULL.
- **Real Brevo (free account):**
  - Signup without an invitation and through an invitation, ticked and
    unticked: everyone lands on the product list, and only ticked users on
    the marketing list.
  - Then change email address, change role, move organization, and make a
    Stripe-test plan change. Each change should appear on one contact. An
    email change should not create a second contact, and none of these changes
    should touch lists.
  - Unsubscribe a test contact from marketing in Brevo, then change its role:
    it must stay unsubscribed.
- **Local stub** via `BREVO_API_URL`, answering 500, 429 with a reset header,
  401, and a 400 for an invalid email. Check that the cursor stops on the first
  three and moves on after the fourth, with a row in `cloud.crm_skipped`.
- **Configuration:**
  - With the variables unset: no cursor row, no Brevo traffic, `/health`
    reports `crm: unconfigured`, and billing is unchanged.
  - With only some of them set: the service refuses to start.
  - With a list id that doesn't exist in Brevo: the CRM consumer stays off and
    the log names the list.
  - With the variables added later: the backlog from before they were set is
    synced.
- **Backfill:**
  - A user with no event gets a contact on the product list only.
  - A second run creates nothing new.
  - A run during live signups produces no duplicates.

## Docs to update with the change

- `docs/billing.md`: retitle "Account events" or add a "CRM (Brevo)" section
  covering the variables, the two lists and the consent rule, the attribute
  list, what is never sent, failure handling, the backfill, and replaying
  `cloud.crm_skipped`.
- `CLAUDE.md`, "Plans and billing": one bullet for the CRM consumer (starts at
  the oldest event, contact keyed on `ext_id`, live read, lists only on
  create, fixed attribute list, failure table). Change "Brevo CRM sync … join
  it later" to present tense. Add a line in "Who may sign up" or "Email
  verification" saying the consent column exists and is written only in hosted
  mode.
- `apps/cloud/src/main.ts` and `outbox.ts` header comments.

## Later (not in this change)

- **Opting in or out from the profile page:** a hosted-only toggle that writes
  `marketing_consent_at` and a new `user.marketing_consent_changed` event,
  which the consumer turns into adding to or removing from the marketing list.
  This is the only path besides signup that may ever touch list membership.
- **Organizations as Brevo companies:** `org.created` → `POST /companies`,
  members linked through `link-unlink`, `org.deleted` → delete. Worth doing
  once sales works per account rather than per person.
- **Activation signals:** a "first connection created" date, or a "last MCP
  use" date from `usage.rollup`. These would need a decision against the
  payload rules above, so they are left out on purpose.
- **A nightly full reconcile** that re-upserts every user, as a backstop like
  the hourly Stripe one. Only worth it if `cloud.crm_skipped` or drift shows
  it is needed.

## Decisions

- **Lists:** two, `BREVO_PRODUCT_LIST` and `BREVO_MARKETING_LIST`. Everyone goes
  on the product list. Only users who ticked the signup checkbox go on the
  marketing list.
- **Users from before the outbox:** one-off backfill script (Part 3), product
  list only.
- **Names:** the whole name in `FULL_NAME`, never split.
- **Privacy policy:** updated to name Brevo as a sub-processor.

## Open question

- **Checkbox wording.** The label above is a suggestion. Whatever ships, keep
  it matched to what the marketing list is actually used for, since that text
  is what the consent covers.

## Implementation notes

Where the build differs from, or adds to, the design above:

- **Start-up checks are retried, not one-shot.** A failed check (missing list,
  wrong key, attribute of the wrong type, web migration
  `0009_marketing_consent` not yet applied) is logged and retried every five
  minutes, so a Brevo outage at boot does not need a restart. `/health` reports
  `crm: 'unconfigured' | 'waiting' | 'ready'`.
- **The two list ids must differ**, or the service refuses to start.
- **`BREVO_API_KEY` is the switch, not all-or-none.** List ids set without the
  key are ignored and named in the boot log instead of refusing to start, since
  a Railway PR environment drops the sealed key but keeps the ids. With the key
  set, a missing or non-numeric list id still refuses to start.
- **The backfill honours consent recorded at signup.** A new contact goes on the
  marketing list when `marketing_consent_at` is set. No account from before the
  checkbox has it, so for those the result is the product list only, as above.
- **Consent is re-checked at verify time.** A verification row written in
  hosted mode is honoured only if the deployment is still hosted when the code
  is entered.
- **The backfill also replays skips.** Rerunning it upserts every account, so
  it is how a `cloud.crm_skipped` entry is retried once its cause is fixed.
- **Attributes a user does not have are left out**, rather than sent empty, so
  an update never clears `SIGNUP_PLAN` or `INVITED`.

Tested locally against Postgres 16, a stand-in for Brevo's `/v3` API built from
its API reference, and a local SMTP sink:

- **Configuration:** with no Brevo variables set, there is no cursor row and no
  traffic. Partial, non-numeric and repeated list ids each refuse to start. A
  missing list or a wrong key leaves the sync `waiting`, with a log line that
  names the cause.
- **Backlog:** signups made before the key was set were synced from the oldest
  event once it was. The three events of one signup became one call.
- **Lists and attributes:**
  - Signups with and without consent, direct and through email verification,
    landed on the right lists.
  - An invited signup was recorded with `INVITED`.
  - An existing Brevo contact for the same address was claimed, keeping its
    other list.
  - An email change updated the same contact.
  - Role and plan changes arrived, and a contact unsubscribed from the
    marketing list was not re-added.
- **Failures:** a permanent 400 was recorded in `cloud.crm_skipped` without the
  address being logged, and the sync moved on. Two 500s held the cursor until
  the third pass. A 429 waited out its reset. A database outage was recovered
  from.
- **Backfill:** an account with no event got a product-list-only contact. A
  second run created nothing. A previously skipped account was picked up.
- **Self-hosted:** there was no checkbox, consent sent anyway was stored as
  NULL, and no events were written.

**Not tested against the real Brevo API.** The behaviours listed under "The
upsert, per user" still need checking against a free account before the
variables are set in production.
