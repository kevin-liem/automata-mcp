# Main and DOPE branch differences

The initial comparison covered upstream `main` at `5a0d442` and `dope` at
`d213038`. See the latest Main entry in [merge history](#merge-history) for the
reviewed upstream tip. Use `git diff origin/main dope` to compare branch contents.

## Current differences

| Area | Main | DOPE |
| --- | --- | --- |
| Agent OAuth | Native connector tokens in a Bearer header or URL. | `dev` adds an optional [built-in OAuth module](oauth.md), disabled by default, using existing Automata accounts and token policies. |
| WhatsApp media | WhatsApp tools read and search message records and send text. | Also includes `dev`'s `get-whatsapp-media` tool: scoped, size-capped attachment retrieval with five-minute download links, live authorization, and explicit native, file or base64 delivery. |
| Tool-call history | Hosted Free requires recording, including after a downgrade to Free. On Pro and self-hosted deployments, an admin can opt in from the Organization page. | Recording starts off on every plan. An organization admin can explicitly enable it through `PATCH /api/org` with `recordToolCalls: true`. The Organization page omits the switch. The legacy `tool_calls_required` field is cleared by the cloud service. |
| PostHog | Hosted browser analytics collect pageviews and connection and token events when `NUXT_PUBLIC_POSTHOG_KEY` is configured. | The PostHog integration is deferred. |
| Brevo | The hosted contact sync includes the last MCP use date for the member and their organization when telemetry is enabled. | DOPE retains the existing hosted contact sync. The two MCP activity dates are deferred. |
| Branding and support | Automata app, account email, and sign-in security labels. Hosted account security notices direct readers to Automata support. | DOPE app title, icons, email sender and templates, passkey and authenticator labels, and the default `Sent using DOPE` footer. Account security notices direct readers to their organization admin. |
| Sign-in email | Uses the standard profile email-change and verification flow. | `NUXT_DISABLE_EMAIL_CHANGE=true` makes the sign-in email read-only and blocks confirmation of pending changes. Signup verification still follows its own setting. |

Tool-call history lives in `app.mcp_tool_calls` in the app's PostgreSQL database.
It holds the tool, outcome, timestamp, token and connection IDs, user agent, and
an optional model-written reason. A daily task prunes rows older than 30 days.
Turning recording off stops new entries, and older entries age out on schedule.
Token last-used timestamps and MCP client metadata are recorded separately on
both branches. Hosted mode also keeps aggregate usage counts in
`app.hosted_events`. See [storage](self-hosting.md#the-app-database) and
[tool-call history](using-automata.md#telemetry).

## Features to revisit

The commits below are already ancestors of `dope`. To adopt a deferred feature,
review its upstream patch with `git show <commit>` and port it as a new change.

- **Hosted PostHog browser analytics** — `96779ad`, `90a1524`, `46b3481`.
  Start with `apps/web/app/plugins/posthog.client.ts`,
  `apps/web/app/composables/analytics.ts`, and the event call sites in those
  patches. Decide how signed-out traffic, identification,
  opt-out events, and destination settings should work on DOPE before enabling
  capture. Upstream uses the organization telemetry setting, including its
  mandatory Free policy, and records an opt-out event with the user ID.
- **Brevo MCP activity dates** — `b93350a`, `1a73121`. The upstream cloud
  service derives `LAST_MCP_USE` and `ORG_LAST_MCP_USE` from token last-used
  timestamps. See `apps/cloud/src/crm.ts` for contact updates and
  `apps/cloud/src/crm-activity.ts` for the daily sync.
  Review which organizations can share the dates and how the integration
  clears previously shared dates when recording is turned off. Upstream sends
  an empty string to clear a date.
- **Organization telemetry control and Free policy** — inspect `5d5ce11` for
  the DOPE changes to the Organization page, plan defaults, API, and MCP auth.
  The UI control can be restored separately from mandatory recording. Any
  change to the default or downgrade behavior needs an explicit decision.

## Updating this record

1. Fetch `main` and review its commits since the last recorded merge. On
   `dope` or a sync branch based on it, use
   `git merge --no-ff --no-commit origin/main` so the result can be reviewed
   before committing. Ask the owner before resolving a conflict between the
   branches' goals.
2. Update the comparison and deferred features when behavior changes. Add an
   entry at the top of the history for every incoming `main` merge, even if the
   branches' differences stay the same. Use the heading format shown below with
   the full incoming `main` SHA, followed by bullets covering what
   landed and any changes retained, adapted, or deferred. Get the incoming
   SHA with `git rev-parse MERGE_HEAD` during the merge.
3. Stage this file with the merge. Run
   `node .github/scripts/check-dope-merge.mjs` before committing. If using a
   sync branch and pull request, use a merge commit to preserve the incoming
   `main` history. To check local `dope` merge commits automatically, configure
   `git config --local core.hooksPath .githooks` once per clone. The
   `dope-merge` GitHub Actions workflow checks pull requests and pushes to
   `dope`. GitHub can require its `merge-notes` check through branch protection.

Update this page in the same change when a deferred feature is adopted later.

## Merge history

### Dev `6810135dafd2f36b87139a14ccf65c78c570db16`

- **2026-11-13.** Added WhatsApp media retrieval, signed download links bound
  to current connector credentials, GET/HEAD downloads, media tests, and
  `AGENTS.md`.
- Kept indexed message search alongside the new exact-message lookup filter,
  newer status and LID documentation, DOPE branding, the sign-in email lock,
  opt-in tool-call history, and the deferred PostHog and Brevo activity dates.

### Main `5a0d442f58e0d3060db3bcfdace12ec3f0b82d4a`

- **2026-11-13 · `d213038`.** Applied Telegram write serialization, retries
  and recovery, PostgreSQL autovacuum migrations, self-hosted rate-limit and
  Redis settings, MCP discovery documentation, and beta image publishing
  with manual promotion to stable tags.
- Kept DOPE branding and opt-in tool-call history. Deferred PostHog tracking
  and Brevo MCP activity dates by the owner's decision.

### Main `0364af5a7f02742b9901751f0992a81e84678be0`

- **2026-11-12 · `b753c78`.** Applied release 1.3.2, MCP rate limits,
  WhatsApp stuck-session detection and chat lookup improvements, indexed
  WhatsApp and Telegram search, Telegram sync and hosted Free history limits,
  IMAP attachment and flag-sync fixes, and deployment updates.
- Kept DOPE branding, the sign-in email lock, and opt-in tool-call history
  for Free and Pro by the owner's decision.

### Main `6b8bc69996328aebaa7ed2c771be3e71e9f45934`

- **2026-11-09 · `0317688`.** Merged `main` into the branch then called
  `custom`. Kept the sign-in email lock from `cab076c`. The DOPE branding and
  telemetry changes followed in `036ba71`, `ee7630d`, `5d5ce11`, and `72039c1`.
