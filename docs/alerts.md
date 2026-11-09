# Connection alerts

A WhatsApp or Telegram connection that stops working emails everyone who can
reach it, and emails them again once it recovers. Always on, no setting; it needs SMTP
configured on the web service (`NUXT_SMTP_*`) and nothing else.

The same SMTP settings deliver organization invitations: the invitation-link
dialog has **Send invite email**, and each pending invitation has **Resend
email**, which replaces the old link with a new one. Without SMTP both answer
with an error and the link can still be copied by hand.

**Who gets it:** every admin of the owning organization, plus the members the
connection is assigned to — the same set that can reach it in the app, decided by
the same predicate. One message each rather than one message addressed to all of
them, so nobody's alert discloses the roster. The two roles get different advice:
reconnecting and re-pairing are management, so a member is told what happened and
that an admin can fix it rather than being sent to press a button they do not
have.

Two things feed it, and they are not redundant.

| | What it catches | Latency |
|---|---|---|
| Per-connection webhook | logout, ban, session replaced, QR limit; for Telegram, any state change the bridge sees | seconds |
| Five-minute sweep | everything, including a socket that died and never came back, and a Telegram bridge that is down | up to five minutes |

The sweep is not a backstop for a flaky webhook. In Evolution 2.3.7 a close that
Evolution intends to **retry** emits no `connection.update` at all — it rebuilds
the socket and returns — so the failure worth catching most is the one the
webhook can never report. That is the same disagreement `sessionLost` is built
on: the stored column still says `open`, nothing live is behind it, and the
dashboard showed "Connected" for a week over a dead socket. Only a live read
finds it, and the sweep is what performs one.

Both paths end in the same function, and **neither trusts the webhook payload**.
Its `state` is never read. Evolution v2 does not sign deliveries, so the route is
reachable by anyone who knows the URL; a delivery means *look at this
connection*, and `GET /instance/connectionState` says what is actually true. A
forged post costs one rate-limited round-trip and can never produce an email.

What it will and will not send:

- A connection that has **never been paired** is skipped. A fresh instance sits
  in `close` until somebody scans its QR code, and `ownerJid` is the only thing
  that tells that apart from a logout.
- Nothing is mailed until a connection has been down for **10 minutes**, in any
  state, `close` included. A drop that recovers inside that window mails nobody,
  so a short blip no longer produces an outage mail followed seconds later by a
  recovery mail. The sweep runs every five minutes, so a real outage is reported
  10–15 minutes after it starts.
- One mail per outage. `alerted_at` is written only once a message actually went
  out, so a broken SMTP configuration delays an alert rather than losing it.
- The mail says which fix applies: a dropped session asks for **Reconnect**, an
  unlinked account asks for a QR scan. Sending someone to scan a code they did
  not need to costs a real phone.
- A WhatsApp **reconnect loop** counts as an outage too, even though nearly every
  live read finds it `open`. Two sockets on one set of credentials keep
  replacing each other (`conflict: replaced`), and neither the webhook nor the
  live state shows it. The sweep reads when Evolution last wrote the account's
  `"Instance"` row, which happens on every socket open. Ten minutes of fresh
  writes on an `open` row marks the connection unstable, and the 10-minute grace
  above runs from there, so the mail goes out 20–25 minutes into the loop. It
  says restarting the Evolution service is the fix, since Reconnect cannot help,
  and the web log gets a line saying the same. See [whatsapp.md](whatsapp.md)
  "Stuck reconnecting".

### Telling the operator about a reconnect loop

A reconnect loop is the one outage nobody in the organization can fix: only
whoever runs the Evolution service can restart it. Set `NUXT_OPS_ALERT_EMAIL`
on the web service and that address is mailed as soon as a connection on the
deployment's own Evolution server is marked unstable (no grace period), and once
more when the loop has ended. The mail names the connection id, the Evolution
instance name and the organization id, and nothing the organization typed. A
connection on a server the organization supplied is not reported: that server
is theirs to restart. Unset, no operator mail is sent.

Like the organization's mail, it is sent at most once per loop, across replicas,
and a failed send is retried on the next sweep rather than lost.

**On the hosted offering** (`NUXT_CLOUD_URL` set), the address also changes
what customers read. With it set (and SMTP configured), the outage mail, the
dashboard and `get-connection-status` (`operatorAlerted: true`) say the loop is
on our side, that we have been alerted, and that there is nothing for them to
do — for admins and members alike. Without it they keep the self-hosted wording
("whoever runs this deployment has to restart its Evolution service"), since
promising that somebody has been told is only true if somebody was. Set it on
every hosted deployment.

**Telegram** follows the same rules, with four failures told apart:

| What happened | What the mail says |
|---|---|
| The connection to Telegram dropped | Press **Reconnect**; no scan |
| The session was ended from Telegram → Settings → Devices, or by Telegram | Link again by QR code; synced chats are kept |
| The bridge could not be reached | Nothing to scan; check the bridge service |
| Another bridge process holds the session | Nothing to scan; run the bridge as one instance |

A Telegram connection counts as linked from its first link until someone presses
**Unlink**. It keeps counting through a dropped connection or a revoked session,
so those alert, and an unlink closes an open outage without mailing anyone. A
bridge that cannot be reached is treated as an outage even for a connection that
was never linked, because the app cannot tell the two apart from outside.

The bridge posts to `/api/webhook/telegram` with the same `x-webhook-secret`, and
the route reads the live state back from the bridge before acting, exactly like
Evolution's. Deliveries go to `NUXT_TELEGRAM_WEBHOOK_URL` if it is set, and
otherwise to `NUXT_PUBLIC_APP_URL` + `/api/webhook/telegram` — so on Railway
there is nothing to set, and in development `.env.example` points it at
`host.docker.internal`.

The sweep runs in-process on the `alerts:sweep` scheduled task, so keep the web
service to a single replica or it mails twice. In development the tasks are
reachable by hand at `/_nitro/tasks/alerts:sweep`.

Registration is re-asserted every hour by a separate scheduled task,
`alerts:register-webhooks`, which is what picks up a connection created before
this existed, or one whose Evolution server or Telegram bridge was rebuilt. It
uses the connection's own key, not a global one.

To try it locally without a mail provider, run a catcher and point
`NUXT_SMTP_HOST` at it (Nuxt runs on the host, so `localhost`):

```bash
docker run -d --name wamcp-mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit:v1.21
# .env: NUXT_SMTP_HOST=localhost, NUXT_SMTP_PORT=1025, NUXT_MAIL_FROM=alerts@automata.test
```

Then read what was sent at <http://localhost:8025>. A failed send is logged by
`[mailer]` with what to check. The sweep can be triggered
by hand in development with `curl -X POST
http://localhost:3000/_nitro/tasks/alerts:sweep`.

## Account emails

The same SMTP settings send the account emails: signup verification (with or
without an invitation), "you already have an account", the code for an address
change, the notice to the old address once it changes, invitations, password
resets (asked for by the account's owner or sent by an admin), and the notice
that a password was changed. Unlike
the alerts, which are plain text, these are HTML with a plain-text alternative,
written by the templates in `apps/web/server/emails/`.

- The header logo is `/email/automata-email-logo.png` on the web app, linked
  through `NUXT_PUBLIC_APP_URL`. Without that URL the header shows the name as
  text, and the mails carry the code but no links.
- The footer says why the mail was sent. On the hosted service it also carries
  the company's postal address, and the address-change and password-changed
  notices offer "Contact us"; a self-hosted deployment sends neither, and tells the reader to contact
  an admin of their organization instead.
- The sender is `NUXT_MAIL_FROM` / `NUXT_MAIL_FROM_NAME` for every mail,
  invitations included.

`apps/web/test/__snapshots__/emails/` holds a rendered copy of each; open the
`.html` files in a browser to see them.
