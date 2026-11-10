// Snapshot and rule checks for the account emails in server/emails/.
//
//   pnpm test:emails                       compare against the snapshots
//   UPDATE_SNAPSHOTS=1 pnpm test:emails    rewrite them after a deliberate change
//
// Node loads the .ts templates directly (type stripping, Node >= 22.18); they
// import nothing from Nuxt for this reason. The .html snapshots open in a
// browser as they would in an inbox, so a change to one is reviewable as a page.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  alreadyRegisteredEmail, emailChangedNoticeEmail, emailChangeVerificationEmail,
  invitationEmail, invitedSignupVerificationEmail, passwordChangedNoticeEmail,
  passwordResetEmail, signupVerificationEmail,
} from '../server/emails/account.ts'
import { COMPANY_ADDRESS, maskEmail } from '../server/emails/layout.ts'

const here = dirname(fileURLToPath(import.meta.url))
const snapshotDir = join(here, '__snapshots__', 'emails')
const update = process.env.UPDATE_SNAPSHOTS === '1'

const hosted = { appUrl: 'https://dope.example.com', hosted: true }
const selfHosted = { appUrl: 'https://dope-self-hosted.example.com', hosted: false }
const noAppUrl = { hosted: false }

const VERIFY_TTL = 30 * 60 * 1000
const INVITE_TTL = 14 * 24 * 60 * 60 * 1000
const RESET_TTL = 30 * 60 * 1000
const changedAt = new Date('2026-11-07T22:02:00Z')
const link = brand => `${brand.appUrl}/verify-email?token=SAMPLE-link-token`
const resetLink = brand => `${brand.appUrl}/reset-password?token=SAMPLE-link-token`

/** Every email, with the sample values the canvas uses. */
const cases = {
  '1a-signup-verification': signupVerificationEmail({ code: '123456', url: link(hosted), expiresInMs: VERIFY_TTL }, hosted),
  '1a-signup-verification-no-app-url': signupVerificationEmail({ code: '123456', expiresInMs: VERIFY_TTL }, noAppUrl),
  '1b-invited-signup-verification': invitedSignupVerificationEmail({ code: '123456', url: link(hosted), expiresInMs: VERIFY_TTL, orgName: 'Acme', role: 'admin' }, hosted),
  '2-already-registered': alreadyRegisteredEmail(hosted),
  '2-already-registered-no-app-url': alreadyRegisteredEmail(noAppUrl),
  '3-email-change-verification': emailChangeVerificationEmail({ code: '123456', url: link(hosted), expiresInMs: VERIFY_TTL, currentEmail: 'old@example.com', newEmail: 'new@example.com' }, hosted),
  '4-email-changed-notice': emailChangedNoticeEmail({ previousEmail: 'old@example.com', newEmail: 'new@example.com', changedAt }, hosted),
  '4-email-changed-notice-self-hosted': emailChangedNoticeEmail({ previousEmail: 'old@example.com', newEmail: 'new@example.com', changedAt }, selfHosted),
  '5-invitation': invitationEmail({ inviterName: 'Jane Doe', orgName: 'Acme', role: 'member', email: 'invitee@example.com', url: `${hosted.appUrl}/invite/waorg_SAMPLE`, expiresInMs: INVITE_TTL }, hosted),
  '5-invitation-admin-self-hosted': invitationEmail({ inviterName: 'Jane Doe', orgName: 'Acme', role: 'admin', email: 'invitee@example.com', url: `${selfHosted.appUrl}/invite/waorg_SAMPLE`, expiresInMs: INVITE_TTL }, selfHosted),
  '6a-password-reset': passwordResetEmail({ code: '123456', url: resetLink(hosted), expiresInMs: RESET_TTL }, hosted),
  '6a-password-reset-no-app-url': passwordResetEmail({ code: '123456', expiresInMs: RESET_TTL }, noAppUrl),
  '6b-password-reset-by-admin': passwordResetEmail({ code: '123456', url: resetLink(hosted), expiresInMs: RESET_TTL, requestedBy: { orgName: 'Acme' } }, hosted),
  '6b-password-reset-by-admin-self-hosted': passwordResetEmail({ code: '123456', url: resetLink(selfHosted), expiresInMs: RESET_TTL, requestedBy: { orgName: 'Acme' } }, selfHosted),
  '7-password-changed-notice': passwordChangedNoticeEmail({ email: 'person@example.com', changedAt, how: 'reset' }, hosted),
  '7-password-changed-notice-self-hosted': passwordChangedNoticeEmail({ email: 'person@example.com', changedAt, how: 'profile' }, selfHosted),
}

function snapshotText(mail) {
  return `Subject: ${mail.subject}\nPreview: ${mail.preview}\n\n${mail.text}`
}

function matchSnapshot(file, actual) {
  const path = join(snapshotDir, file)
  if (update || !existsSync(path)) {
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(path, actual)
    return
  }
  const expected = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  assert.equal(actual, expected, `${file} differs from its snapshot (UPDATE_SNAPSHOTS=1 to accept)`)
}

/** The HTML's visible text, for comparing wording with the plain-text part. */
function visibleText(html) {
  return html
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .replace(/<div style="display:none[\s\S]*?<\/div>/, '')
    .replace(/<br>/g, '\n')
    .replace(/<\/?(strong|a|span)\b[^>]*>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&rarr;/g, '→').replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
}

for (const [name, mail] of Object.entries(cases)) {
  test(`${name}: matches its snapshots`, () => {
    matchSnapshot(`${name}.html`, mail.html)
    matchSnapshot(`${name}.txt`, snapshotText(mail))
  })

  test(`${name}: email-safe markup`, () => {
    for (const banned of ['<svg', 'display:flex', 'display: flex', 'display:grid', '<link', '<style', '<script']) {
      assert.ok(!mail.html.includes(banned), `contains ${banned}`)
    }
    assert.match(mail.html, /<table role="presentation" width="600"[^>]*max-width:600px/)
    assert.ok(mail.html.includes('font-family:\'Space Grotesk\', Arial, sans-serif'))
    // Every link sets its colour, so no client paints it its own.
    for (const anchor of mail.html.match(/<a [^>]*>/g) ?? []) {
      assert.match(anchor, /style="[^"]*color:#/, `link without a colour: ${anchor}`)
    }
  })

  test(`${name}: lime only as a button label on ink`, () => {
    const lime = mail.html.match(/color:#baf85a/g)?.length ?? 0
    const buttons = mail.html.match(/<td style="background:#17140f;border-radius:10px"><a /g)?.length ?? 0
    assert.equal(lime, buttons)
  })

  test(`${name}: plain text says what the HTML says`, () => {
    const html = visibleText(mail.html).toLowerCase()
    for (const paragraph of mail.text.split('\n\n')) {
      for (const line of paragraph.split('\n')) {
        // A button is `Label: url`; a link inside a sentence is `text <url>`.
        const want = line.replace(/^\s+/, '').replace(/^(.*): (https?:\/\/\S+)$/, '$1').replace(/ <https?:\/\/[^>\s]+>/g, '').trim()
        if (!want || want === '---' || want === '--') continue
        // `Current: old@example.com` is two cells in the HTML.
        for (const piece of want.split(/: (?=\S+@|\d{1,2} \w{3} \d{4})/)) {
          assert.ok(html.includes(piece.toLowerCase()), `text line not in the HTML: ${piece}`)
        }
      }
    }
  })
}

test('footer: company address in hosted mode only', () => {
  for (const [name, mail] of Object.entries(cases)) {
    const isHosted = !name.includes('self-hosted') && !name.includes('no-app-url')
    assert.equal(mail.html.includes(COMPANY_ADDRESS.replace(/&/g, '&amp;')), isHosted, name)
    assert.equal(mail.text.includes(COMPANY_ADDRESS), isHosted, name)
  }
  assert.ok(cases['4-email-changed-notice'].text.includes('Contact an admin of your organization'))
  assert.ok(cases['4-email-changed-notice-self-hosted'].text.includes('Contact an admin of your organization'))
})

test('header: DOPE wordmark and icon from the configured app URL', () => {
  assert.ok(cases['1a-signup-verification'].html.includes(`<img src="${hosted.appUrl}/dope-icon.png" width="36" height="36" alt=""`))
  assert.ok(cases['1a-signup-verification'].html.includes('>DOPE</span>'))
  assert.ok(cases['1a-signup-verification-no-app-url'].html.includes('>DOPE</span>'))
  assert.ok(!cases['1a-signup-verification-no-app-url'].html.includes('<img'))
  assert.ok(!cases['1a-signup-verification-no-app-url'].html.includes('href='))
  assert.ok(!cases['2-already-registered-no-app-url'].html.includes('href='))
})

test('user-typed names are escaped in the HTML and kept to one line in headers', () => {
  const orgName = '<img src=x onerror=alert(1)> "Acme" & Co\r\nBcc: victim@example.com'
  const inviterName = 'Jane <b>Doe</b>\nX-Injected: 1'
  const mails = [
    invitationEmail({ inviterName, orgName, role: 'member', email: 'a"b@example.com', url: 'https://x.test/invite/waorg_1?a=1&b="2"', expiresInMs: INVITE_TTL }, hosted),
    invitedSignupVerificationEmail({ code: '123456', url: 'https://x.test/v?t=1&u=2', expiresInMs: VERIFY_TTL, orgName, role: 'member' }, hosted),
  ]
  for (const mail of mails) {
    assert.ok(!/[\r\n]/.test(mail.subject), mail.subject)
    assert.ok(!/[\r\n]/.test(mail.preview), mail.preview)
    assert.ok(!mail.html.includes('<img src=x'), 'org name reached the HTML as markup')
    assert.ok(!mail.html.includes('<b>'), 'inviter name reached the HTML as markup')
    assert.ok(!mail.html.includes('"Acme"'), 'quotes not escaped')
    assert.ok(mail.html.includes('&lt;img src=x onerror=alert(1)&gt; &quot;Acme&quot; &amp; Co Bcc: victim@example.com'))
    for (const href of mail.html.match(/href="[^"]*"/g) ?? []) assert.ok(!/[<>]/.test(href), href)
  }
  assert.ok(mails[0].html.includes('href="https://x.test/invite/waorg_1?a=1&amp;b=&quot;2&quot;"'))
})

test('email-changed notice masks the new address', () => {
  const mail = cases['4-email-changed-notice']
  assert.ok(!mail.html.includes('new@example.com'))
  assert.ok(!mail.text.includes('new@example.com'))
  assert.ok(mail.text.includes('To: ne•••@example.com'))
  assert.equal(maskEmail('ab@example.com'), 'a•••@example.com')
  assert.equal(maskEmail('a@example.com'), 'a•••@example.com')
  assert.equal(maskEmail('not-an-address'), '•••')
})

test('expiry wording comes from the TTL', () => {
  assert.ok(cases['1a-signup-verification'].text.includes('expire in 30 minutes'))
  assert.ok(cases['3-email-change-verification'].text.includes('expire in 30 minutes. Until you confirm'))
  assert.ok(cases['5-invitation'].text.includes('It expires in 14 days.'))
  assert.ok(cases['6a-password-reset'].text.includes('expire in 30 minutes and work once'))
})

test('already registered: "Forgot your password?" links to the reset page, only with an app URL', () => {
  const mail = cases['2-already-registered']
  assert.ok(mail.html.includes(`href="${hosted.appUrl}/forgot-password"`))
  assert.ok(mail.text.includes(`Forgot your password? Reset it here <${hosted.appUrl}/forgot-password>.`))
  assert.ok(!cases['2-already-registered-no-app-url'].text.includes('Forgot your password?'))
})

test('password reset: link from the app URL only, code always; admin mail names the org, never the admin', () => {
  assert.ok(cases['6a-password-reset'].html.includes(`href="${resetLink(hosted)}"`))
  for (const name of ['6a-password-reset', '6a-password-reset-no-app-url', '6b-password-reset-by-admin']) {
    assert.ok(cases[name].text.includes('    123456'), name)
  }
  const bare = cases['6a-password-reset-no-app-url']
  assert.ok(!bare.html.includes('href='))
  assert.ok(bare.text.includes('under “Forgot password?”, with this email address'))
  const byAdmin = cases['6b-password-reset-by-admin']
  assert.ok(byAdmin.subject.includes('Acme'))
  assert.ok(byAdmin.text.includes('An admin of the organization “Acme”'))
  assert.ok(byAdmin.text.includes('can’t choose your password'))
  const hostile = passwordResetEmail({ code: '123456', expiresInMs: RESET_TTL, requestedBy: { orgName: '<b>Acme</b>\r\nBcc: x@example.com' } }, hosted)
  assert.ok(!/[\r\n]/.test(hostile.subject), hostile.subject)
  assert.ok(!hostile.html.includes('<b>'))
})

test('password-changed notice: directs readers to their admin and says tokens keep working', () => {
  assert.ok(cases['7-password-changed-notice'].text.includes('Contact an admin of your organization'))
  assert.ok(cases['7-password-changed-notice-self-hosted'].text.includes('Contact an admin of your organization'))
  assert.ok(cases['7-password-changed-notice'].text.includes('Every browser signed in to the account was signed out.'))
  assert.ok(cases['7-password-changed-notice-self-hosted'].text.includes('Every other browser'))
  assert.ok(cases['7-password-changed-notice'].text.includes('Connector tokens keep working'))
})
