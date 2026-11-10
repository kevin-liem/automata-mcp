import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import type { EmailBrand } from '../emails/layout'

/**
 * Outbound email, over SMTP from this process.
 *
 * Configured from `NUXT_SMTP_*`. With `NUXT_SMTP_HOST` unset nothing is sent:
 * alerts are still computed, `sendAppEmail` answers false, and the callers that
 * care (the alert bookkeeping, the invitation dialog) treat that as "not
 * delivered" — an alert stays queued for the next sweep, and an invitation's
 * link is still on screen to copy.
 *
 * `NUXT_SMTP_TLS=true` is implicit TLS (port 465). False sends STARTTLS when the
 * server offers it, which is what port 587 wants.
 *
 * Account emails (verification, already registered, email-change notice,
 * invitation, password reset, password-changed notice) are HTML with a
 * plain-text alternative, written by the templates in `server/emails/`.
 * Connection alerts are still plain text.
 */

export interface AppEmail {
  to: string
  subject: string
  text?: string
  html?: string
}

let transport: Transporter | undefined
let warnedUnconfigured = false

function mailTransport(): Transporter | undefined {
  const config = useRuntimeConfig()
  if (!config.smtpHost) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true
      console.warn('[mailer] NUXT_SMTP_HOST is not set; mail (connection alerts, invitation emails) will not be delivered.')
    }
    return undefined
  }

  transport ??= nodemailer.createTransport({
    host: config.smtpHost,
    port: Number(config.smtpPort) || 587,
    secure: String(config.smtpTls) === 'true',
    auth: config.smtpUsername ? { user: config.smtpUsername, pass: config.smtpPassword } : undefined,
  })
  return transport
}

/**
 * What the account-email templates need to know about this deployment. The
 * logo and any link built here need `NUXT_PUBLIC_APP_URL`; without it the
 * header shows the wordmark as text. The company address appears in hosted
 * mode only.
 */
export function emailBrand(): EmailBrand {
  const appUrl = String(useRuntimeConfig().public.appUrl ?? '').trim().replace(/\/+$/, '')
  return { appUrl: appUrl || undefined, hosted: hostedMode() }
}

/**
 * Send one email. Answers whether it went out; never throws.
 *
 * A caller here is a background sweep or a webhook ack, and neither has anyone
 * to report a failure to — so it is logged here, with what to check, and the
 * caller decides what "not sent" means for its own bookkeeping.
 */
export async function sendAppEmail(mail: AppEmail): Promise<boolean> {
  if (!mail.to) return false

  const smtp = mailTransport()
  if (!smtp) return false

  const { mailFrom, mailFromName } = useRuntimeConfig()

  try {
    await smtp.sendMail({
      from: mailFromName ? { name: mailFromName, address: mailFrom } : mailFrom,
      to: mail.to,
      subject: mail.subject,
      text: mail.text || undefined,
      html: mail.html || undefined,
    })
    return true
  }
  catch (error) {
    console.error(
      `[mailer] could not send "${mail.subject}" to ${mail.to}. `
      + 'Check NUXT_SMTP_HOST and friends, and that NUXT_MAIL_FROM is an address the SMTP server may send as:',
      error,
    )
    return false
  }
}
