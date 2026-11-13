# Automata MCP documentation

Product documentation lives at <https://www.getautomata.app/docs>. The pages
here are about running and developing this repository.

**Running it**

- [Self-hosting](self-hosting.md) — the whole app from published images, as one container or with Docker Compose; who can sign up, email verification, password reset; backups, the app database
- [Deploying to Railway](deploy-railway.md) — services, ports and every variable, for the one-click template or by hand
- [Releases](releases.md) — image tags and how a release is cut
- [Plans and billing](billing.md) — the hosted offering only: the cloud service, Stripe, limits, the Brevo CRM sync; nothing a self-hosted deployment sets

**Using it**

- [Using Automata](using-automata.md) — connecting Claude, organizations and roles, the MCP tools, scoping a token, telemetry
- [WhatsApp connections](whatsapp.md) — reading and searching, history import, bringing your own Evolution server
- [Telegram connections](telegram.md) — setting up the bridge, what syncs, bringing your own bridge
- [Database connections](postgres.md) — what the table allowlist does and does not close, least-privilege roles
- [Email (IMAP) connections](imap.md) — what syncs and what stays on the mail server, app passwords, attachments
- [Connection alerts](alerts.md) — disconnect emails and the five-minute sweep, reconnect-loop reports to the operator, account emails (verification, invitations, password reset)
- [Two-factor authentication](two-factor.md) — authenticator apps and passkeys, the `NUXT_PUBLIC_APP_URL` dependency, resetting a lost factor

**Working on it**

- [Main and DOPE branch differences](main-dope-differences.md) — deferred features, merge history, and how to update the record
- [Development](development.md) — layout, local setup, networking and the Linux firewall rule, auth, adding tools
- [Plans](plans/) — design notes for larger changes: [Brevo CRM sync](plans/brevo-crm-sync.md)
