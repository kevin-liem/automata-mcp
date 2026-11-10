/**
 * The shared shell of every account email: header band with the logo, a paper
 * card, a cream footer with the reason line — and, in hosted mode, the
 * company's postal address. Each email in `account.ts` is a list of blocks
 * passed to `renderEmail()`, which writes the HTML and the plain-text
 * alternative from the same blocks, so the two cannot say different things.
 *
 * Email-safe on purpose: tables for layout, every style inline, no SVG, no
 * flexbox or grid, no stylesheet. Colours and type match the web app.
 * Lime appears only as a button label on ink.
 *
 * **Every value goes through `escapeHtml()`.** Organization names, inviter
 * names and addresses are typed by users; one that reaches the HTML raw is
 * markup in someone else's inbox. Subjects and preview text go through
 * `singleLine()`, since a line break in a header is a header of its own.
 *
 * No imports, no Nuxt auto-imports: `apps/web/test/emails.test.mjs` loads this
 * file and `account.ts` straight into Node.
 */

export const color = {
  ink: '#17140f',
  text: '#3d382e',
  textSecondary: '#4a4438',
  textMuted: '#625b4c',
  ivory: '#f4f1e8',
  paper: '#fffdf7',
  cream: '#f4f0e6',
  line: '#e4dece',
  lineStrong: '#d9d3c2',
  codeBg: '#f1ece0',
  codeLine: '#e0d9c7',
  lime: '#baf85a',
  chipNeutral: '#e6e1d2',
} as const

const SANS = `'Space Grotesk', Arial, sans-serif`
const MONO = `'JetBrains Mono', Menlo, Consolas, 'Courier New', monospace`

/** Shown in the footer of hosted deployments only; a self-hosted install is not ours. */
export const COMPANY_ADDRESS = 'Operational Intelligence Inc. · 418 Broadway #6722 · Albany, NY 12207, USA'
/** Served from `apps/web/public/`, reached through `NUXT_PUBLIC_APP_URL`. */
export const LOGO_PATH = '/dope-icon.png'

/** What differs between deployments, read once by the caller (`emailBrand()` in mailer.ts). */
export interface EmailBrand {
  /** `NUXT_PUBLIC_APP_URL`, no trailing slash. Unset: no logo image, no links built from it. */
  appUrl?: string
  /** Hosted mode: the footer carries the company address. */
  hosted: boolean
}

export interface RenderedEmail {
  subject: string
  /** The inbox preview line, also the first thing in the HTML (hidden). */
  preview: string
  html: string
  text: string
}

// ── text helpers ───────────────────────────────────────────────────────────

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A header must not carry a line break; organization and inviter names are user-typed. */
export function singleLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** `30 minutes`, `14 days`: for "expires in …" lines, from the TTL the code really uses. */
export function durationWords(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 120) return plural(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 48) return plural(hours, 'hour')
  return plural(Math.round(hours / 24), 'day')
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `7 Nov 2026`, in UTC, the same for every reader. */
export function formatDate(at: Date): string {
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`
}

/** `7 Nov 2026, 22:02 UTC`. */
export function formatDateTime(at: Date): string {
  const hh = String(at.getUTCHours()).padStart(2, '0')
  const mm = String(at.getUTCMinutes()).padStart(2, '0')
  return `${formatDate(at)}, ${hh}:${mm} UTC`
}

/**
 * `ne•••@example.com`. For the notice sent to the *old* address: it confirms
 * where the account went without handing the full new address to whoever
 * reads the old mailbox, which may no longer be the account's owner.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return '•••'
  const local = email.slice(0, at)
  const keep = [...local].slice(0, local.length > 2 ? 2 : 1).join('')
  return `${keep}•••${email.slice(at)}`
}

// ── inline rich text ───────────────────────────────────────────────────────

/**
 * A run of text: plain body text, bold (ink), or a link inside a sentence (ink,
 * semibold, underlined — the boards' "Reset it here"). The plain-text part
 * writes a link as `text <url>`, so the URL survives a client that shows no HTML.
 */
export type Inline = string | { strong: string } | { link: string, href: string }

function inlineHtml(parts: readonly Inline[]): string {
  return parts.map((part) => {
    if (typeof part === 'string') return escapeHtml(part)
    if ('strong' in part) return `<strong style="color:${color.ink};font-weight:600">${escapeHtml(part.strong)}</strong>`
    return `<a href="${escapeHtml(part.href)}" style="color:${color.ink};font-weight:600;text-decoration:underline">${escapeHtml(part.link)}</a>`
  }).join('')
}

function inlineText(parts: readonly Inline[]): string {
  return parts.map((part) => {
    if (typeof part === 'string') return part
    if ('strong' in part) return part.strong
    return `${part.link} <${part.href}>`
  }).join('')
}

// ── blocks ─────────────────────────────────────────────────────────────────

/** One stacked block of the card body: its HTML and its plain-text form. */
export interface Block { html: string, text: string }

function font(size: number, lineHeight: number | string, weight = 400, extra = ''): string {
  return `font-family:${SANS};font-size:${size}px;line-height:${lineHeight};font-weight:${weight};${extra}`
}

/** Single-cell table, so a block sizes to its content (the boards' `align-self: flex-start`). */
function shrinkTable(cellStyle: string, inner: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr><td style="${cellStyle}">${inner}</td></tr></table>`
}

export function eyebrow(text: string): Block {
  return {
    html: `<div style="${font(12, 1.4, 600, `letter-spacing:0.14em;text-transform:uppercase;color:${color.textMuted}`)}">${escapeHtml(text)}</div>`,
    text: text.toUpperCase(),
  }
}

export function heading(text: string): Block {
  return {
    html: `<h1 style="margin:0;${font(32, 1.12, 600, `letter-spacing:-0.8px;color:${color.ink}`)}">${escapeHtml(text)}</h1>`,
    text,
  }
}

function paragraph(size: number, textColor: string, parts: Inline[]): Block {
  return {
    html: `<p style="margin:0;${font(size, 1.6, 400, `color:${textColor}`)}">${inlineHtml(parts)}</p>`,
    text: inlineText(parts),
  }
}

/** The paragraph under the headline (`lead`, 17px). */
export function lead(...parts: Inline[]): Block {
  return paragraph(17, color.text, parts)
}

/** Body copy (16px). */
export function body(...parts: Inline[]): Block {
  return paragraph(16, color.text, parts)
}

/** Secondary copy (15px), for the "didn't do this?" lines and helper paragraphs. */
export function secondary(...parts: Inline[]): Block {
  return paragraph(15, color.textSecondary, parts)
}

/** Meta line (14px, muted): expiry and the like. */
export function meta(text: string): Block {
  return {
    html: `<div style="${font(14, 1.5, 400, `color:${color.textMuted}`)}">${escapeHtml(text)}</div>`,
    text,
  }
}

/** The six-digit code: monospace, large, letter-spaced, on the code ground. */
export function code(value: string): Block {
  return {
    html: shrinkTable(
      `font-family:${MONO};font-size:34px;line-height:1.2;font-weight:500;letter-spacing:0.28em;color:${color.ink};`
      + `background:${color.codeBg};border:1px solid ${color.codeLine};border-radius:12px;padding:14px 18px 14px 26px;white-space:nowrap`,
      escapeHtml(value),
    ),
    text: `    ${value}`,
  }
}

/** A label line and the link under it, in monospace, ink and underlined. */
export function linkLine(label: string, url: string): Block {
  return {
    html: `<div style="${font(15, 1.5, 400, `color:${color.textSecondary}`)}">${escapeHtml(label)}</div>`
      + `<div style="padding-top:6px;font-family:${MONO};font-size:13px;line-height:1.5;word-break:break-all">`
      + `<a href="${escapeHtml(url)}" style="color:${color.ink};text-decoration:underline">${escapeHtml(url)}</a></div>`,
    text: `${label}\n${url}`,
  }
}

/** A label line and the URL in a code box to copy — beside a button, so not itself a link. */
export function pasteLink(label: string, url: string): Block {
  return {
    html: `<div style="${font(14, 1.5, 400, `color:${color.textMuted}`)}">${escapeHtml(label)}</div>`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;border-collapse:separate"><tr>`
      + `<td style="font-family:${MONO};font-size:13px;line-height:1.5;color:${color.text};background:${color.codeBg};`
      + `border:1px solid ${color.codeLine};border-radius:8px;padding:10px 12px;word-break:break-all">${escapeHtml(url)}</td></tr></table>`,
    text: `${label}\n${url}`,
  }
}

/** The one call to action: ink fill, lime label, 52px tall, trailing arrow. */
export function button(label: string, url: string): Block {
  return {
    html: shrinkTable(
      `background:${color.ink};border-radius:10px`,
      `<a href="${escapeHtml(url)}" style="display:inline-block;padding:16px 26px;${font(16, '20px', 600, `color:${color.lime};text-decoration:none`)}">`
      + `${escapeHtml(label)}&nbsp;&nbsp;&rarr;</a>`,
    ),
    text: `${label}: ${url}`,
  }
}

export function divider(): Block {
  return {
    html: `<div style="height:1px;line-height:1px;font-size:1px;background:${color.line}">&nbsp;</div>`,
    text: '---',
  }
}

function creamPanel(padding: string, inner: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr>`
    + `<td style="background:${color.cream};border-radius:12px;padding:${padding}">${inner}</td></tr></table>`
}

/** A cream panel with a bold line and a body line. */
export function callout(title: string, text: string): Block {
  return {
    html: creamPanel('18px 20px',
      `<div style="${font(16, 1.5, 600, `color:${color.ink}`)}">${escapeHtml(title)}</div>`
      + `<div style="padding-top:6px;${font(15, 1.6, 400, `color:${color.text}`)}">${escapeHtml(text)}</div>`),
    text: `${title}\n${text}`,
  }
}

/** A cream panel of label/value rows separated by hairlines (Current/New, From/To/When). */
export function rows(entries: ReadonlyArray<readonly [label: string, value: string]>): Block {
  const html = entries.map(([label, value], i) => {
    const rule = i === 0 ? '' : `<tr><td colspan="2" style="padding:10px 0">${divider().html}</td></tr>`
    return rule
      + `<tr><td valign="top" style="${font(15, 1.5, 400, `color:${color.textMuted};padding-right:16px;white-space:nowrap`)}">${escapeHtml(label)}</td>`
      + `<td valign="top" align="right" style="${font(15, 1.5, 600, `color:${color.ink};text-align:right;word-break:break-all`)}">${escapeHtml(value)}</td></tr>`
  }).join('')
  return {
    html: creamPanel('16px 20px', `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${html}</table>`),
    text: entries.map(([label, value]) => `${label}: ${value}`).join('\n'),
  }
}

/** A cream panel with a title and description on the left and a neutral chip on the right. */
export function chipCard(title: string, text: string, chip: string): Block {
  return {
    html: creamPanel('16px 20px', `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`
      + `<td valign="middle"><div style="${font(15, 1.5, 600, `color:${color.ink}`)}">${escapeHtml(title)}</div>`
      + `<div style="padding-top:4px;${font(14, 1.5, 400, `color:${color.textSecondary}`)}">${escapeHtml(text)}</div></td>`
      + `<td valign="middle" align="right" style="padding-left:16px;white-space:nowrap">`
      + `<span style="display:inline-block;${font(13, 1.4, 600, `color:${color.ink};background:${color.chipNeutral};padding:5px 10px;border-radius:999px`)}">${escapeHtml(chip)}</span></td>`
      + `</tr></table>`),
    text: `${title}\n${text}`,
  }
}

// ── the shell ──────────────────────────────────────────────────────────────

export interface EmailParts {
  subject: string
  preview: string
  /** The footer's first line: why this address got this mail. */
  reason: string
  /** Falsy entries (an optional link, a button with no URL to point at) are skipped. */
  blocks: ReadonlyArray<Block | undefined | false | ''>
}

/**
 * Hidden preheader. The run of zero-width joiners and spaces after the preview
 * keeps clients from filling the rest of the preview line with the header's
 * alt text and the first paragraph.
 */
function preheader(preview: string): string {
  return `<div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${color.cream};opacity:0">`
    + `${escapeHtml(preview)}${'&#8199;&#65279;&#847; '.repeat(60)}</div>`
}

function header(brand: EmailBrand): string {
  const wordmark = `<span style="${font(20, '36px', 600, `letter-spacing:-0.4px;color:${color.ivory}`)}">DOPE</span>`
  const mark = brand.appUrl
    ? '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
      + `<td valign="middle" style="padding-right:10px"><img src="${escapeHtml(`${brand.appUrl}${LOGO_PATH}`)}" `
      + 'width="36" height="36" alt="" style="display:block;border:0"></td>'
      + `<td valign="middle">${wordmark}</td></tr></table>`
    : wordmark
  return `<tr><td style="background:${color.ink};padding:22px 40px">${mark}</td></tr>`
}

function footerLines(reason: string, brand: EmailBrand): string[] {
  return brand.hosted ? [reason, COMPANY_ADDRESS] : [reason]
}

export function renderEmail(parts: EmailParts, brand: EmailBrand): RenderedEmail {
  const subject = singleLine(parts.subject)
  const preview = singleLine(parts.preview)
  const blocks = parts.blocks.filter((b): b is Block => Boolean(b))
  const footer = footerLines(parts.reason, brand)

  const bodyRows = blocks.map((block, i) =>
    `<tr><td style="padding:0 0 ${i === blocks.length - 1 ? 0 : 20}px">${block.html}</td></tr>`).join('')

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${color.cream};-webkit-text-size-adjust:100%">
${preheader(preview)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${color.cream}">
<tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${color.paper};border:1px solid ${color.lineStrong};border-radius:14px;border-collapse:separate;overflow:hidden">
${header(brand)}
<tr><td style="padding:40px 40px 36px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${bodyRows}</table>
</td></tr>
<tr><td style="background:${color.cream};border-top:1px solid ${color.line};padding:22px 40px;${font(13, 1.6, 400, `color:${color.textMuted}`)}">${footer.map(escapeHtml).join('<br>')}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`

  const text = [...blocks.map(b => b.text), ['--', ...footer].join('\n')].join('\n\n') + '\n'
  return { subject, preview, html, text }
}
