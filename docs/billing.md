# Plans and billing

The hosted offering lets people sign up on their own and pick a plan first. This
page explains how to run that. **A self-hosted deployment does not need any of
it.** Leave `NUXT_CLOUD_URL` unset: there is then no plan picker, no Billing
page, no limits, and no account events.

The hosted offering is two services:

- **The web app** enforces limits and shows the Billing page. It never talks
  to Stripe.
- **The cloud service** (`apps/cloud`) sells plans. It owns Stripe (Checkout,
  the Customer Portal, the webhook, seat billing) and writes each
  organization's limits. It also keeps a Brevo CRM contact for every user
  (see [CRM (Brevo)](#crm-brevo)). PostHog product analytics joins it later.

Self-hosted deployments never run the cloud service.

## The plans

| | Free | Pro |
|---|---|---|
| Price | $0 | 7-day trial, then $19/month |
| Connections | 1 | unlimited |
| Connector tokens | 1 | unlimited |
| Users | 1 | 5 included, $10/user/month after |
| Requests | unlimited | unlimited |
| WhatsApp history at pairing | recent only | recent, or full if chosen |

**WhatsApp history.** Every new WhatsApp connection imports the recent history
by default: what WhatsApp hands any linked browser, rather than everything the
phone holds. Live messages from then on are all kept. **Import full history**
on the create form asks for everything instead. A full import is most of the
disk an account costs, so on Free that box is locked with an Upgrade link, and
the server refuses it (402 `plan_limit`). The lock applies only to connections on
the deployment's own Evolution server, never to a bring-your-own one, and it
deletes nothing: history already imported stays when an organization moves to
Free, and moving to Pro imports nothing by itself. An admin who upgrades presses
**Import full history** on the connection's dashboard, which costs a QR scan. See [WhatsApp history](whatsapp.md#recent-history-only).

The numbers are set in three places:

- **Limits and plan rules:** `apps/cloud/src/plans.ts`.
- **Copy:** `apps/web/app/pages/signup.vue` and `billing.vue`.
- **Prices:** the two Stripe prices below.

Change all three together.

## How it behaves

### Signing up and starting the trial

- The signup page asks for a plan first. A link with `?plan=free` or
  `?plan=pro` skips that step, so a marketing site can link straight to the
  plan.
- **Every new organization starts on Free.** Choosing Pro sends the browser on
  to Stripe Checkout after signup (after email verification, when that is on).
  The organization becomes Pro only when Stripe confirms the subscription.
- If someone abandons Checkout, they have a working Free account and can start
  the trial later from the Billing page.
- The trial needs a card. Stripe charges $19 on day 8 unless the trial is
  cancelled first.
- Each organization gets one trial. An organization that has ever held a
  subscription is offered a plain upgrade with no trial.

### Seats

Members beyond the included five are billed seats, charged with proration. The
app updates the seat price's quantity on its own whenever someone joins or is
removed. Pending invitations are not billed.

### When a subscription lapses

A trial that ends unpaid, a card that fails for good, or a cancellation puts
the organization back on Free. **Nothing is deleted.** While it holds more than
Free allows:

- It cannot add connections, tokens or members. The server answers 402
  `plan_limit`, and the UI offers admins the Billing page.
- Exactly one connector token keeps working: the oldest live token on the
  oldest connection.
- Every other token answers **403**, never 401, so the MCP client keeps it.
  Resubscribing brings every token back with nothing to reconfigure.
- Everyone in the organization sees a banner about it.

`past_due` counts as Pro while Stripe is still retrying the charge. Your
retry settings in Stripe decide how long that lasts.

## How limits are stored

The plan and its limits are kept apart:
- **Plan:** Stripe status, decided by the billing code.
- **Limits:** three plain numbers on each organization, `max_connections`, `max_tokens` and `max_members`. NULL means unlimited.
- **Recent WhatsApp history only:** one more flag, `recent_history_only`. While it is true, the organization's WhatsApp connections on this deployment's Evolution server can't import full history (see above). It's true on Free and false on Pro.

The cloud service writes those values whenever a subscription changes, and for every organization each time it starts. The web app's checks only ever read them, so they keep working, from the database, even while the cloud service is down.

A new organization gets the limits in `app.entitlement_defaults`, which the cloud service writes when it starts. Until that row exists, a hosted signup answers 503 rather than creating an organization with no limits. That only happens if the web app is deployed before the cloud service has ever run.

Unsetting `NUXT_CLOUD_URL` stops new limits from being written. It does **not** clear limits already written. A deployment that switches the hosted offering off after using it should clear them:

```sql
UPDATE app.organizations SET max_connections = NULL, max_tokens = NULL, max_members = NULL, plan_label = NULL, tool_calls_required = false, recent_history_only = false;
```

## Account events

On the hosted deployment the web app also records account and organization changes in `app.hosted_events`. The cloud service reads them. Billing acts on membership changes (to bill seats) and on deleted organizations (to cancel what they were paying for). The CRM sync acts on signups, email and membership changes, and plan changes. Product analytics (PostHog) will read the same rows later; tool-call telemetry and its reasons are never among them. The changes recorded:
- signups and email changes;
- organizations created and deleted;
- members joining, leaving and changing role;
- connections and tokens created and removed;
- plan changes;
- a per-minute count of MCP tool calls per organization.

Each consumer keeps its own position in `cloud.cursors`, and nothing deletes rows. A consumer added later therefore starts from the whole backlog.

Events never contain credentials, connection strings, chat or table names, message content or tool arguments. Email addresses appear only on user events. A self-hosted deployment writes none.

## CRM (Brevo)

The cloud service keeps one Brevo contact per user. A signup appears in Brevo within about 15 seconds. Later changes to the email address, organization, role and plan update the same contact.

### Marketing consent

The hosted signup page, and the signup form behind an invitation link, show a checkbox: "Send me product news and tips by email. You can unsubscribe at any time." On the signup page it starts ticked only for a visitor outside the EU, EEA, UK, Switzerland, Canada and Brazil, where a pre-ticked box does not count as consent. Two signals decide, and either one placing the visitor inside leaves the box unticked: the browser's time zone (a zone it cannot place, including `UTC`, which privacy-hardened browsers report, counts as inside), then the visitor's country. For that the browser asks the web app, which passes the visitor's IP address to the cloud service, which looks it up with `IP_LOOKUP_URL` (default: RevBull's zip-prepop service at `https://api.revbull-services.com/ip-to-zip/zip`) and caches the answer for an hour. The browser never contacts the lookup service, and addresses are never logged. The lookup is skipped when the time zone already decides, and if it fails or times out the time zone decides alone. The invitation form always starts unticked. The zone list is in `apps/web/app/composables/marketingOptIn.ts`, the country list in `apps/cloud/src/consent-region.ts`. Submitting with the box ticked records the time in `app.users.marketing_consent_at`. That column records consent **given at signup**, not whether the person is still subscribed: Brevo owns that, and nothing here re-adds someone who unsubscribed. The checkbox's wording on any date is in the git history of `apps/web/app/components/MarketingConsent.vue`.

A self-hosted deployment shows no checkbox and ignores the field if a client sends it.

### Lists

- **Product list** (`BREVO_PRODUCT_LIST`): everyone.
- **Marketing list** (`BREVO_MARKETING_LIST`): only those who ticked the box.

Lists are set **only when a contact is created**, or when an existing contact for the same address (a newsletter signup, say) is claimed by a new account. Later updates never touch list membership, so an unsubscribe is never undone.

### What a contact holds

A contact is keyed on the user's id (Brevo's `ext_id`), so an email change updates the same contact rather than creating a second one.

| Brevo attribute | Holds |
|---|---|
| `FULL_NAME` | the account name, whole |
| `SIGNUP_DATE` | the date the account was created |
| `SIGNUP_PLAN` | `free` or `pro` as picked at signup; empty for invited signups |
| `INVITED` | whether they signed up through an invitation |
| `ORG_ID`, `ORG_NAME`, `ORG_ROLE` | their organization and role (`admin` / `member`) |
| `PLAN` | the organization's current plan (`Free`, `Pro`, `Pro (trial)`) |

That is the whole list. Nothing about connections, tokens or usage is sent. The service creates any missing attribute when it starts, and refuses to start the sync if one exists with a different type.

### Setting it up

1. In Brevo, create an API key (**SMTP & API → API keys**) and two contact lists. Note each list's numeric id.
2. If your Brevo account restricts API keys to authorised IP addresses, allow the cloud service's outbound address.
3. On the cloud service, set:

   ```bash
   BREVO_API_KEY=xkeysib-…
   BREVO_PRODUCT_LIST=…      # numeric list id
   BREVO_MARKETING_LIST=…    # numeric list id, different from the product list
   ```

   `BREVO_API_KEY` turns the sync on. Without it there is no sync, and any list ids set are ignored (the startup log names them), so a Railway PR environment that lost the sealed key still starts. With the key set, both list ids are required and must differ. A missing, non-numeric or repeated list id stops the service from starting.
4. Redeploy. `GET /health` reports `crm`:
   - `unconfigured`: `BREVO_API_KEY` is not set.
   - `waiting`: the start-up checks have not passed yet. The log says why: the web app's migration `0009_marketing_consent` is missing, a list doesn't exist, the key is wrong, or an attribute exists with the wrong type. The service checks again every 15 seconds while the migration is missing, and every five minutes otherwise; billing is unaffected.
   - `ready`: the sync is running.

   The first time the sync runs, it starts from the **oldest** retained event, so every signup since the event log existed becomes a contact.
5. Run the backfill once (below) for accounts created before the event log existed.

### Backfill

Accounts created before the event log have no signup event, so the sync never sees them. The backfill upserts a contact for every account:

```bash
node src/crm-backfill.ts      # in the cloud service's container (e.g. `railway ssh`)
pnpm cloud:crm-backfill       # locally, with the variables in the root .env
```

- It is safe to rerun, and safe to run while the service is running. An account that already has a contact is updated, and updates never touch lists.
- New contacts go on the product list, and on the marketing list only when the account ticked the box at signup. Accounts from before the checkbox were never asked, so none of them reach it.
- It sends no `SIGNUP_PLAN` or `INVITED`, because none were recorded for these accounts.

### When Brevo says no

| Brevo answers | The sync |
|---|---|
| nothing, 5xx, or 429 | stops just before that user's event and retries on a later pass, after Brevo's rate-limit reset if it gave one |
| 401 or 403 | stops and logs once a minute that the key, or Brevo's authorised IPs, is wrong |
| any other 4xx (for example, an address Brevo calls invalid) | records it in `cloud.crm_skipped` and moves on |

`cloud.crm_skipped` holds the event id, user id, status and Brevo's error code, but never the address. Once the cause is fixed, rerun the backfill: it updates or creates every contact, including skipped ones.

Logs never contain an address, a name, the API key or a request body.

## Setting up Stripe

### 1. Create the product and prices

Create one product, "Automata Pro", with two recurring monthly prices:

- **Base:** $19.00, flat rate, licensed. Put its id in the cloud service's
  `STRIPE_PRICE_BASE`.
- **Seat:** $10.00 per unit, licensed (not metered). Put its id in
  `STRIPE_PRICE_SEAT`.

### 2. Add the webhook endpoint

Point it at the **cloud service**, `https://<cloud service>/webhooks/stripe`, with these events:

- `checkout.session.completed`
- `customer.subscription.created`, `.updated`, `.deleted`, `.paused`,
  `.resumed`, `.trial_will_end`

Put its signing secret in the cloud service's `STRIPE_WEBHOOK_SECRET`.

The cloud service writes nothing from the event itself. It looks up the
customer's organization and re-reads that customer's subscriptions from
Stripe. An hourly reconcile does the same for every billed organization, so a
lost delivery corrects itself within the hour.

### 3. Configure the Customer Portal

Under **Settings → Billing → Customer portal**:

- **Allow:** updating the payment method, viewing invoices, and cancelling
  subscriptions.
- **Do not allow:** changing quantities or switching plans. Seats follow
  membership, and the app resets any quantity edited by hand.

### 4. Turn on Stripe's own emails

Under **Settings → Billing → Subscriptions and emails**, enable:

- the trial-ending reminder;
- failed-payment emails;
- the retry schedule (smart retries).

The app sends none of these itself.

### 5. Promotion codes (optional)

Checkout shows an "Add promotion code" field. To comp an account or run a
promo, create a coupon under **Product catalog → Coupons** (for example 100% off,
forever), then add a customer-facing **promotion code** to it — the code is what
people type, the coupon on its own has none. A code applied at Checkout stays on
the subscription, so a 100%-off-forever code keeps invoices at $0 while the
organization reads as Pro.

### 6. Deploy the cloud service

On Railway, add a service from this repository:
- **Root directory:** the repo root.
- **Dockerfile path:** `apps/cloud/Dockerfile`.
- **Public domain:** give it one; Stripe needs to reach `/webhooks/stripe`.

Set its variables:

```bash
CLOUD_DATABASE_URL=postgres://…        # the same database as the web app's NUXT_DATABASE_URL
CLOUD_ADMIN_KEY=…                      # openssl rand -hex 32; the web app sends it on every call
APP_URL=https://mcp.getautomata.app    # the web app's public address: Checkout returns here
STRIPE_SECRET_KEY=rk_live_…            # the restricted key
STRIPE_WEBHOOK_SECRET=whsec_…
STRIPE_PRICE_BASE=price_…
STRIPE_PRICE_SEAT=price_…
```

`STRIPE_SECRET_KEY` turns billing on. Without it the service still runs and still writes limits, but starting Pro answers 503, and any other `STRIPE_*` variables are ignored (the startup log names them). With it set, the other three are required and the service refuses to start without them.

This is what lets a Railway PR environment start. Railway never copies sealed variables into a PR environment, so the two secrets go missing while the price ids arrive. The preview then runs without billing. To test Checkout in previews, give the PR environment's base environment unsealed **test-mode** values. Never use live keys there.

`GET /health` answers `{ ok, app, billing, crm }`. `app` is `waiting` until the web app has run its migrations; the cloud service waits for them rather than failing.

**Database access.** The service connects to the web app's database. It reads `app` tables, writes only organizations' billing and limit columns, `app.hosted_events` and `app.entitlement_defaults`, and keeps its own state in a `cloud` schema it creates. The simplest setup reuses the web app's database URL. To narrow it, give it a role with:
- `USAGE` on the `app` schema;
- `SELECT` on `app.organizations`, `app.memberships`, `app.hosted_events`, `app.migrations` and `app.entitlement_defaults` (its `INSERT … ON CONFLICT DO UPDATE` reads the row it replaces);
- with the CRM sync on, `SELECT (id, email, name, created, marketing_consent_at)` on `app.users`;
- `UPDATE` on `app.organizations`;
- `INSERT` on `app.hosted_events` and `INSERT, UPDATE` on `app.entitlement_defaults`;
- `CREATE` on the database, or an existing `cloud` schema it owns.

It never needs `app.instances`, where connection credentials live.

### 7. Point the web app at it

On the web service:

```bash
NUXT_CLOUD_URL=http://<cloud service>.railway.internal:8080   # its private address
NUXT_CLOUD_ADMIN_KEY=…                              # the same value as CLOUD_ADMIN_KEY
NUXT_PUBLIC_APP_URL=https://mcp.getautomata.app
NUXT_SIGNUP=open
NUXT_OPS_ALERT_EMAIL=…                              # where reconnect loops on our Evolution are reported
```

`NUXT_OPS_ALERT_EMAIL` is not about billing, but hosted mode is what makes it
matter: with it set, a customer whose WhatsApp connection is stuck reconnecting
is told the fix is on us and that we have been alerted. Without it they are told
"whoever runs this deployment" has to restart Evolution, which they cannot do.
See [alerts.md](alerts.md).

Railway injects `PORT=8080` into every service, and the cloud service follows it.

### Upgrading from the single-service setup

Before the cloud service existed, the web app talked to Stripe itself, configured with `NUXT_BILLING` and `NUXT_STRIPE_*`. To move over:

1. Deploy the cloud service (step 6). It writes `app.entitlement_defaults` and re-derives every organization's limits as soon as the web app's migration `0022_recent_history_only` has run.
2. On the web service, set `NUXT_CLOUD_URL` and `NUXT_CLOUD_ADMIN_KEY`, and remove `NUXT_BILLING` and the four `NUXT_STRIPE_*` variables.
3. In Stripe, change the webhook destination's URL from `https://<web app>/api/webhook/stripe` to `https://<cloud service>/webhooks/stripe`. The signing secret stays the same.

Deliveries Stripe sends to the old URL in the meantime fail and are retried. The hourly reconcile also catches up anything missed.

If the web app is upgraded with `NUXT_BILLING` still set and no `NUXT_CLOUD_URL`, plans stay enforced and the Billing page answers 503. The startup log says which variables to set; nothing becomes unlimited.

### Startup checks and failure behaviour

- Both services log anything missing at boot.
- **Limits are enforced from the database even when the cloud service is down or has no Stripe keys.** Starting Pro then answers 503, and the Billing page still shows the limits and usage.
- **New organizations need the defaults row.** A hosted signup is refused with 503 until the cloud service has started once.

## Testing locally

1. Start the cloud service with `pnpm cloud:dev`. It reads the same root `.env`, so set `CLOUD_*`, `APP_URL`, `STRIPE_*` and `BREVO_*` there. Point the web app at it with `NUXT_CLOUD_URL=http://localhost:8096`. To test the CRM sync's failure handling, set `BREVO_API_URL` to a local stub that answers like Brevo's `/v3` API.
2. Run `stripe listen --forward-to localhost:8096/webhooks/stripe` and use
   the `whsec_…` it prints.
3. Use test-mode keys and prices, and card `4242 4242 4242 4242`.
4. To see a trial end without waiting seven days, attach a Stripe test clock to
   the customer and advance it. Card `4000 0000 0000 0341` attaches fine and
   then fails its first charge.

## Things to keep in mind

- **Hosted mode turns off bring-your-own Evolution servers and Telegram
  bridges.** Creating a WhatsApp or Telegram connection on a user's own server,
  or setting a per-connection message database URL, answers 422 and the create
  page doesn't offer it. Every self-signup is an organization admin, and such a
  server is an address they chose that this deployment dials on a schedule
  (GHSA-g2cf-mx92-xc53). Rows created before hosted mode was turned on keep
  working. IMAP and Postgres connections are unaffected.
- **An organization deleted by its last member leaving cancels its
  subscription.** When the only member of an organization accepts an
  invitation elsewhere, the old organization is deleted. The cloud service
  sees the `org.deleted` event and cancels any live subscription that
  organization's Stripe customer holds, immediately.
- **Two checkouts started in two tabs can create two subscriptions.** Stripe
  allows this. The app refuses a new Checkout once a live subscription exists,
  but cannot stop two that are already open. If it happens, cancel the extra
  one in the Stripe dashboard.
- **Each subscription is tied to one Stripe customer per organization.** It is
  created on first checkout and recorded in `app.organizations.stripe_customer_id`.
