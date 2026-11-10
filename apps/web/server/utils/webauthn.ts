import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import type { AppUser, Db } from './app-db'
import type { LoginChallenge } from './mfa'

/**
 * Passkeys and security keys, as a second factor (never instead of the
 * password).
 *
 * The relying party — the domain a credential is bound to — comes from
 * `NUXT_PUBLIC_APP_URL`, never from the request's `Host`. A credential is only
 * as bound as the origin the server expects: reading it off the request would
 * accept an assertion made for whatever host the request claimed. Consequence
 * an operator should know: moving the app to another domain makes every
 * registered passkey unusable (authenticator codes survive).
 *
 * Challenges live in `app.mfa_challenges`, not memory, so a second replica can
 * finish what the first started.
 */

const RP_NAME = 'DOPE'
const REGISTRATION_TTL_MS = 5 * 60 * 1000

interface RelyingParty {
  id: string
  origin: string
}

export function relyingParty(): RelyingParty | undefined {
  const appUrl = useRuntimeConfig().public.appUrl
  if (!appUrl) return undefined
  try {
    const url = new URL(appUrl)
    return { id: url.hostname, origin: url.origin }
  }
  catch {
    return undefined
  }
}

function requireRelyingParty(): RelyingParty {
  const rp = relyingParty()
  if (!rp) {
    console.error('[webauthn] passkeys need NUXT_PUBLIC_APP_URL set to the address people open the app at')
    throw createError({ statusCode: 501, statusMessage: 'Passkeys need NUXT_PUBLIC_APP_URL to be set on this deployment' })
  }
  return rp
}

interface CredentialRow {
  id: string
  credential_id: string
  public_key: Buffer
  counter: string
  transports: string[]
}

async function credentialsOf(db: Db, userId: string): Promise<CredentialRow[]> {
  return await db<CredentialRow[]>`
    SELECT id, credential_id, public_key, counter, transports
    FROM app.webauthn_credentials WHERE user_id = ${userId}
  `
}

// ── registration (signed in, from the profile dialog) ──────────────────────

export async function passkeyRegistrationOptions(user: AppUser): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const rp = requireRelyingParty()
  const sql = await appDb()
  const existing = await credentialsOf(sql, user.id)

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.id,
    userName: user.email,
    userDisplayName: user.name || user.email,
    // Stable per account, so registering a second key on the same
    // authenticator replaces rather than duplicates.
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map(c => ({ id: c.credential_id, transports: c.transports })),
    authenticatorSelection: {
      // A second factor needs no discoverable credential, and hardware keys
      // have few slots for them.
      residentKey: 'discouraged',
      userVerification: 'preferred',
    },
  })

  // One registration in flight per user: a newer request replaces the older.
  await sql.begin(async (tx) => {
    await tx`DELETE FROM app.mfa_challenges WHERE user_id = ${user.id} AND purpose = 'register'`
    await tx`
      INSERT INTO app.mfa_challenges (user_id, purpose, webauthn_challenge, expires_at)
      VALUES (${user.id}, 'register', ${options.challenge}, ${new Date(Date.now() + REGISTRATION_TTL_MS)})
    `
  })
  return options
}

/**
 * Verify a new credential and store it, inside the caller's transaction. The
 * registration challenge is spent by a conditional delete first, so the same
 * response cannot register twice.
 */
export async function savePasskey(
  tx: Db,
  user: AppUser,
  response: RegistrationResponseJSON,
  name: string,
): Promise<{ id: string, name: string, created: string }> {
  const rp = requireRelyingParty()

  const [challenge] = await tx<{ webauthn_challenge: string }[]>`
    DELETE FROM app.mfa_challenges
    WHERE user_id = ${user.id} AND purpose = 'register' AND expires_at > now()
    RETURNING webauthn_challenge
  `
  if (!challenge) {
    throw createError({ statusCode: 409, statusMessage: 'Passkey setup expired. Start again.' })
  }

  let verification
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.webauthn_challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
    })
  }
  catch (error) {
    console.warn(`[webauthn] registration for user ${user.id} refused:`, (error as Error).message)
    throw createError({ statusCode: 400, statusMessage: 'This passkey could not be verified' })
  }
  if (!verification.verified) {
    throw createError({ statusCode: 400, statusMessage: 'This passkey could not be verified' })
  }

  const { credential } = verification.registrationInfo
  try {
    const [row] = await tx<{ id: string, name: string, created: string }[]>`
      INSERT INTO app.webauthn_credentials (user_id, credential_id, public_key, counter, transports, name)
      VALUES (
        ${user.id}, ${credential.id}, ${Buffer.from(credential.publicKey)}, ${credential.counter},
        ${credential.transports ?? []}, ${name}
      )
      RETURNING id, name, created
    `
    return row!
  }
  catch (error) {
    if (isUniqueViolation(error)) {
      throw createError({ statusCode: 409, statusMessage: 'This passkey is already registered' })
    }
    throw error
  }
}

// ── sign-in (second step) ──────────────────────────────────────────────────

/** Options for the sign-in prompt, with the challenge stored on the sign-in. */
export async function passkeyLoginOptions(challenge: LoginChallenge): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const rp = requireRelyingParty()
  const sql = await appDb()
  const credentials = await credentialsOf(sql, challenge.user_id)

  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    allowCredentials: credentials.map(c => ({ id: c.credential_id, transports: c.transports })),
    userVerification: 'preferred',
  })
  await sql`UPDATE app.mfa_challenges SET webauthn_challenge = ${options.challenge} WHERE id = ${challenge.id}`
  return options
}

/**
 * Check a sign-in assertion. Answers the reason it failed, or `undefined` when
 * it passed. The credential must belong to this user — an assertion from
 * someone else's key, however valid, is not this account's second factor.
 *
 * The library refuses a signature counter that went backwards (a cloned
 * authenticator), which arrives here as a failure like any other.
 */
export async function checkPasskeyAssertion(
  challenge: LoginChallenge,
  response: AuthenticationResponseJSON,
): Promise<string | undefined> {
  const rp = requireRelyingParty()
  if (!challenge.webauthn_challenge) return 'no passkey prompt was issued for this sign-in'

  const sql = await appDb()
  // Take the prompt's challenge first, conditionally: single-use whether the
  // assertion passes or not, and two copies of one response cannot both use it.
  const [taken] = await sql`
    UPDATE app.mfa_challenges SET webauthn_challenge = NULL
    WHERE id = ${challenge.id} AND webauthn_challenge = ${challenge.webauthn_challenge}
    RETURNING id
  `
  if (!taken) return 'passkey prompt was already answered'

  const [row] = await sql<CredentialRow[]>`
    SELECT id, credential_id, public_key, counter, transports
    FROM app.webauthn_credentials
    WHERE user_id = ${challenge.user_id} AND credential_id = ${response.id}
  `
  if (!row) return 'passkey is not registered to this account'

  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.webauthn_challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(row.public_key),
        counter: Number(row.counter),
        transports: row.transports,
      },
      requireUserVerification: false,
    })
  }
  catch (error) {
    return `passkey assertion refused: ${(error as Error).message}`
  }
  if (!verification.verified) return 'passkey assertion did not verify'

  await sql`
    UPDATE app.webauthn_credentials
    SET counter = ${verification.authenticationInfo.newCounter}, last_used_at = now()
    WHERE id = ${row.id}
  `
  return undefined
}
