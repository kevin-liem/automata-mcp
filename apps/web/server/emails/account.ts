import {
  body, button, callout, chipCard, code, divider, durationWords, eyebrow, formatDate, formatDateTime,
  heading, lead, linkLine, maskEmail, meta, pasteLink, renderEmail, rows, secondary,
  singleLine,
} from './layout.ts'
import type { EmailBrand, RenderedEmail } from './layout.ts'

/**
 * The account emails: signup verification (self and invited), already
 * registered, email-change verification, email-changed notice, invitation,
 * password reset (self and admin-requested), password-changed notice.
 * Copy comes from the "Account emails" boards on the Claude Design canvas;
 * the differences from it, and why, are listed in the PR that added them.
 *
 * Pure: every value arrives as a parameter, nothing is read from the request
 * or the database here. The callers in `server/utils/` decide what to send;
 * these decide only how it reads.
 */

export type MemberRole = 'admin' | 'member'

/** A user-typed name, safe for a subject line, with a fallback when empty. */
function nameOr(value: string | undefined, fallback: string): string {
  return singleLine(value ?? '') || fallback
}

function roleArticle(role: MemberRole): string {
  return role === 'admin' ? 'an admin' : 'a member'
}

// ── 1a · signup verification ───────────────────────────────────────────────

export function signupVerificationEmail(p: {
  code: string
  /** Absent when `NUXT_PUBLIC_APP_URL` is unset: the mail carries the code alone. */
  url?: string
  /** The TTL the row was written with. */
  expiresInMs: number
}, brand: EmailBrand): RenderedEmail {
  return renderEmail({
    subject: 'Confirm your email for DOPE',
    preview: `Your code is ${p.code}. Enter it in the browser where you signed up.`,
    reason: 'You’re getting this because someone signed up for DOPE with this address.',
    blocks: [
      heading('Confirm your email.'),
      lead('Someone signed up for DOPE with this address and chose a password for the account. If that was you, enter this code in the browser where you signed up:'),
      code(p.code),
      p.url && linkLine('Or open this link in that same browser:', p.url),
      meta(`The code and link expire in ${durationWords(p.expiresInMs)}.`),
      divider(),
      secondary({ strong: 'Didn’t sign up?' }, ' Don’t enter the code. Ignore this email and no account is confirmed.'),
    ],
  }, brand)
}

// ── 1b · signup verification, invited ──────────────────────────────────────

export function invitedSignupVerificationEmail(p: {
  code: string
  url?: string
  expiresInMs: number
  orgName: string
  role: MemberRole
}, brand: EmailBrand): RenderedEmail {
  const org = nameOr(p.orgName, 'an organization')
  return renderEmail({
    subject: `Confirm your email to join ${org}`,
    preview: `Your code is ${p.code}. Didn’t sign up yourself? Don’t confirm.`,
    reason: `You’re getting this because this address was invited to ${org} on DOPE and someone used the invitation to sign up.`,
    blocks: [
      eyebrow(`Joining ${org}`),
      heading(`Confirm your email to join ${org}.`),
      lead(`Someone signed up with this address to join the organization “${org}” as ${roleArticle(p.role)}, and chose a password for the account. If that was you, enter this code in the browser where you signed up:`),
      code(p.code),
      p.url && linkLine('Or open this link in that same browser:', p.url),
      meta(`The code and link expire in ${durationWords(p.expiresInMs)}.`),
      callout(
        'Didn’t sign up yourself? Don’t confirm.',
        'Someone holding your invitation link may be trying to join as you. Ignore this email and tell whoever invited you.',
      ),
    ],
  }, brand)
}

// ── 2 · already registered ─────────────────────────────────────────────────

export function alreadyRegisteredEmail(brand: EmailBrand): RenderedEmail {
  return renderEmail({
    subject: 'You already have a DOPE account',
    preview: 'Sign in instead, or ignore this if it wasn’t you.',
    reason: 'You’re getting this because someone tried to sign up for DOPE with this address.',
    blocks: [
      heading('You already have an account.'),
      lead('Someone just tried to sign up for DOPE with this email address. It already has an account, so we didn’t create a new one.'),
      brand.appUrl && button('Sign in', `${brand.appUrl}/login`),
      brand.appUrl && secondary({ strong: 'Forgot your password?' }, ' ', { link: 'Reset it here', href: `${brand.appUrl}/forgot-password` }, '.'),
      secondary({ strong: 'Signing up from an invitation?' }, ' Sign in with this address, then open the invitation link again to accept it.'),
      divider(),
      secondary('Wasn’t you? You can safely ignore this email. Nothing on your account has changed.'),
    ],
  }, brand)
}

// ── 3 · email-change verification (to the new address) ─────────────────────

export function emailChangeVerificationEmail(p: {
  code: string
  url?: string
  expiresInMs: number
  currentEmail: string
  newEmail: string
}, brand: EmailBrand): RenderedEmail {
  return renderEmail({
    subject: 'Confirm your new email address',
    preview: `Your code is ${p.code}. Enter it where you asked for the change.`,
    reason: 'You’re getting this because someone asked to move a DOPE account to this address.',
    blocks: [
      heading('Confirm your new email address.'),
      lead('You asked to change the email on your DOPE account to this address.'),
      rows([['Current', p.currentEmail], ['New', p.newEmail]]),
      body('To confirm, enter this code in the browser where you asked for the change:'),
      code(p.code),
      p.url && linkLine('Or open this link in the browser where you asked for the change:', p.url),
      meta(`The code and link expire in ${durationWords(p.expiresInMs)}. Until you confirm, your account keeps using your current address.`),
      divider(),
      secondary({ strong: 'Didn’t ask for this?' }, ' Don’t enter the code. Ignore this email and nothing changes.'),
    ],
  }, brand)
}

// ── 4 · email-changed notice (to the old address) ──────────────────────────

export function emailChangedNoticeEmail(p: {
  previousEmail: string
  newEmail: string
  changedAt: Date
}, brand: EmailBrand): RenderedEmail {
  return renderEmail({
    subject: 'Your DOPE email address was changed',
    preview: 'If this wasn’t you, contact an admin of your organization right away.',
    reason: `You’re getting this security notice because this address was on a DOPE account until ${formatDate(p.changedAt)}. We won’t send anything else here.`,
    blocks: [
      eyebrow('Security notice'),
      heading('Your email address was changed.'),
      lead('The email on your DOPE account is no longer this address. Sign-in, invitations and connection alerts now go to the new one.'),
      rows([['From', p.previousEmail], ['To', maskEmail(p.newEmail)], ['When', formatDateTime(p.changedAt)]]),
      body('If you made this change, there’s nothing to do.'),
      divider(),
      body({ strong: 'Didn’t make this change?' }, ' Someone may have access to your account. Contact an admin of your organization right away.'),
    ],
  }, brand)
}

// ── 5 · invitation ─────────────────────────────────────────────────────────

const ROLE_CARD: Record<MemberRole, { title: string, text: string, chip: string }> = {
  member: {
    title: 'You’ll join as a Member',
    text: 'Use the connections an admin assigns to you, and manage your own tokens on them.',
    chip: 'Member',
  },
  // Not on the canvas, which shows the member case only; written to match
  // what `org.ts` lets an admin do.
  admin: {
    title: 'You’ll join as an Admin',
    text: 'Manage the organization: invite people, create connections, assign them and mint tokens.',
    chip: 'Admin',
  },
}

export function invitationEmail(p: {
  /** The inviter's name, or their address when they set none. */
  inviterName: string
  orgName: string
  role: MemberRole
  email: string
  url: string
  expiresInMs: number
}, brand: EmailBrand): RenderedEmail {
  const inviter = nameOr(p.inviterName, 'Someone')
  const org = nameOr(p.orgName, 'an organization')
  const card = ROLE_CARD[p.role]
  return renderEmail({
    subject: `${inviter} invited you to ${org} on DOPE`,
    preview: 'Accept to use the connections they share with you.',
    reason: `You’re getting this because ${inviter} invited this address to ${org} on DOPE.`,
    blocks: [
      eyebrow('Invitation'),
      heading(`${inviter} invited you to ${org}.`),
      lead(`DOPE lets AI tools like Claude reach WhatsApp, Telegram, email and PostgreSQL, limited to the exact chats, folders and tables an admin allows. ${org} uses it, and wants you on board.`),
      chipCard(card.title, card.text, card.chip),
      button('Accept invitation', p.url),
      pasteLink('Button not working? Paste this link into your browser:', p.url),
      secondary(
        'This invitation is for ',
        { strong: p.email },
        `. Sign in or sign up with that address to accept it; it won’t work for anyone else. It expires in ${durationWords(p.expiresInMs)}. Already in another organization on DOPE? Accepting moves you to ${org}.`,
      ),
      divider(),
      secondary('Not expecting this? You can ignore it. Nothing happens unless you accept.'),
    ],
  }, brand)
}

// ── 6 · password reset (self, or requested by an admin) ────────────────────

export function passwordResetEmail(p: {
  code: string
  /** Absent when `NUXT_PUBLIC_APP_URL` is unset: the mail carries the code alone. */
  url?: string
  /** The TTL the row was written with. */
  expiresInMs: number
  /**
   * Set when an admin of the account's organization sent it from the Team
   * page. Names the organization, never the admin: an unexpected reset must
   * be recognisable as one, and the button is all the admin did.
   */
  requestedBy?: { orgName: string }
}, brand: EmailBrand): RenderedEmail {
  const expiry = meta(`The code and link expire in ${durationWords(p.expiresInMs)} and work once. Your current password keeps working until you choose a new one.`)
  // The link works in any browser; the code needs the reset page and the address.
  const codeIntro = p.url
    ? body('Or enter this code on the password reset page:')
    : body('Enter this code on the DOPE sign-in page, under “Forgot password?”, with this email address:')

  if (p.requestedBy) {
    const org = nameOr(p.requestedBy.orgName, 'your organization')
    return renderEmail({
      subject: `An admin of ${org} sent you a password reset`,
      preview: `Your code is ${p.code}. Only you can choose the new password.`,
      reason: `You’re getting this because an admin of ${org} on DOPE asked to send a password reset to this address.`,
      blocks: [
        eyebrow(`Requested by ${org}`),
        heading('Choose a new password.'),
        lead(`An admin of the organization “${org}” asked DOPE to send you a password reset. They can’t see this code or link, and they can’t choose your password. Only you can, from this email.`),
        p.url && button('Choose a new password', p.url),
        codeIntro,
        code(p.code),
        expiry,
        divider(),
        secondary({ strong: 'Not expecting this?' }, ` Ignore this email and your password stays the same. If you didn’t ask anyone at ${org} for a reset, let them know.`),
      ],
    }, brand)
  }

  return renderEmail({
    subject: 'Reset your DOPE password',
    preview: `Your code is ${p.code}. Didn’t ask for it? Ignore this email.`,
    reason: 'You’re getting this because someone asked to reset the password of the DOPE account at this address.',
    blocks: [
      heading('Reset your password.'),
      lead('Someone asked to reset the password of the DOPE account at this address. If that was you, choose a new one:'),
      p.url && button('Choose a new password', p.url),
      codeIntro,
      code(p.code),
      expiry,
      divider(),
      secondary({ strong: 'Didn’t ask for this?' }, ' Don’t use the code. Ignore this email and your password stays the same.'),
    ],
  }, brand)
}

// ── 7 · password-changed notice ────────────────────────────────────────────

export function passwordChangedNoticeEmail(p: {
  email: string
  changedAt: Date
  /** `reset`: from a mailed reset, every session ended. `profile`: signed in, other sessions ended. */
  how: 'reset' | 'profile'
}, brand: EmailBrand): RenderedEmail {
  const what = p.how === 'reset'
    ? 'The password of your DOPE account was reset with a code or link sent to this address. Every browser signed in to the account was signed out.'
    : 'The password of your DOPE account was changed from its profile page. Every other browser signed in to the account was signed out.'
  return renderEmail({
    subject: 'Your DOPE password was changed',
    preview: 'If this wasn’t you, contact an admin of your organization right away.',
    reason: 'You’re getting this security notice because the password of the DOPE account at this address changed.',
    blocks: [
      eyebrow('Security notice'),
      heading('Your password was changed.'),
      lead(what),
      rows([['Account', p.email], ['When', formatDateTime(p.changedAt)]]),
      body('If you made this change, there’s nothing to do. Connector tokens keep working: a password change doesn’t revoke them. Revoke one from its connection’s page if you think it has leaked.'),
      divider(),
      body({ strong: 'Didn’t make this change?' }, ' Someone may have access to your email or your account. Contact an admin of your organization right away.'),
    ],
  }, brand)
}
