# Two-factor authentication

Anyone can turn on a second sign-in step for their own account under
**Profile → Two-factor authentication**. They can use either or both of:

- **An authenticator app.** Google Authenticator, 1Password, Authy, or any app
  that reads an `otpauth://` QR code: 6 digits, 30 seconds, SHA-1.
- **Passkeys and security keys.** WebAuthn, so this covers platform passkeys
  (Touch ID, Windows Hello, a phone) and hardware keys like a YubiKey.

Adding the first factor also mints **ten recovery codes**. They are shown once,
and each one signs in once. You can regenerate them from the same dialog, which
invalidates every old code.

It is opt-in per person. An organization admin can't require it, and can't see
or reset another member's factors.

## What it covers

Only the web sign-in. **Connector tokens are not affected.** An MCP token is a
credential in its own right, and Claude can't answer a second-factor prompt. To
cut off a leaked token, rotate or revoke it from its connection's page.

A passkey is only a second factor. You still type your password first, and
there is no passwordless sign-in.

## How sign-in works with it on

1. Email and password, as before. If they are right and the account has a
   factor, no session starts yet. The browser gets a five-minute, httpOnly
   cookie scoped to `/api/auth/login`, backed by a row in `app.mfa_challenges`.
   An account has one pending sign-in at a time: entering the password again
   cancels the earlier one.
2. The person answers with a code, a passkey, or a recovery code. A right answer
   deletes the challenge and starts the normal session. Each answer uses up one
   of five attempts as it arrives, before it is checked, so sending many at once
   gets no more than five; after that the challenge is deleted and the password
   has to be entered again.

Each authenticator code works once, and a code seen over someone's shoulder
can't be replayed. Throttles refuse further attempts for a while after ten
in fifteen minutes: per account for the second step (failed attempts only), and per email
and per client address for the password. They are in memory, per process.

Adding or removing a factor, or regenerating recovery codes, asks for the
current password. Turning 2FA on signs out every other session of that account.

## Passkeys depend on `NUXT_PUBLIC_APP_URL`

A passkey is bound to a domain. The app takes that domain from
`NUXT_PUBLIC_APP_URL`, never from the request, so:

- **`NUXT_PUBLIC_APP_URL` must be the address people actually open the app at.**
  If it is wrong, the browser refuses the passkey prompt. If it is unset,
  passkeys are hidden and the settings say why. Authenticator apps still work.
- **Moving the app to another domain makes every registered passkey unusable.**
  Authenticator apps and recovery codes are unaffected. Before a domain move,
  make sure people have one of those, or warn them to re-add their passkeys.
- Browsers allow WebAuthn only on HTTPS or on `localhost`. Plain HTTP on a LAN
  address won't offer passkeys.

## Someone lost every factor

There is no self-service reset and no admin reset for a second factor. A
password reset doesn't help either: it changes the password only, and signing
in afterwards still asks for the factor. An operator with database access can
turn 2FA off for one account; they can then sign in with their password and
enrol again:

```sql
BEGIN;
DELETE FROM app.totp_credentials     WHERE user_id = (SELECT id FROM app.users WHERE email = 'person@example.com');
DELETE FROM app.webauthn_credentials WHERE user_id = (SELECT id FROM app.users WHERE email = 'person@example.com');
DELETE FROM app.recovery_codes       WHERE user_id = (SELECT id FROM app.users WHERE email = 'person@example.com');
COMMIT;
```

Check who is asking before running this. It removes the protection the person
turned on.

## Storage

| Table | Holds |
|---|---|
| `totp_credentials` | the authenticator secret (plain), the last step a code was accepted for, `confirmed_at`; until confirmed, the session that started setup and the wrong-code count (15 minutes, 5 codes, then set up again) |
| `webauthn_credentials` | credential id, public key, signature counter, transports, name, `last_used_at` |
| `recovery_codes` | SHA-256 of each code, `used_at` |
| `mfa_challenges` | pending sign-ins and passkey registrations, short-lived |

Authenticator secrets are **not encrypted**, like the connection credentials on
`app.instances`. Someone holding a database backup can generate codes. They
still need the password, which is stored only as an scrypt hash. Passkey public
keys are not secret.
