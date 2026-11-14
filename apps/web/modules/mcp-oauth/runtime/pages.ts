import { setHeader, setResponseStatus } from 'h3'
import type { H3Event } from 'h3'
import type { McpAuth } from '../../../server/utils/mcp-auth'

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

export function page(event: H3Event, title: string, body: string, status = 200): string {
  setResponseStatus(event, status)
  setHeader(event, 'content-type', 'text/html; charset=utf-8')
  setHeader(event, 'content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(title)}</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f4f1e8;color:#282820;font:16px/1.6 system-ui,sans-serif}
    main{max-width:660px;margin:6vh auto;padding:24px}section{background:#fffdf7;border:1px solid #dedbd0;border-radius:12px;padding:24px;margin:20px 0}
    h1{font-size:28px;line-height:1.2}h2{font-size:19px}p{overflow-wrap:anywhere}small{color:#68685c}a{color:inherit}
    button{font:inherit;cursor:pointer;border:1px solid #282820;border-radius:6px;padding:8px 18px;margin:8px 8px 0 0;background:#282820;color:#fffdf7}
    button.secondary{background:transparent;color:#282820}fieldset{border:0;padding:0}label{display:block;cursor:pointer;border-top:1px solid #dedbd0;padding:16px 0}
    ul{padding-left:22px}code{overflow-wrap:anywhere}input[type=radio]{accent-color:#282820}
    </style></head><body><main><a href="/instances">← Automata</a><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`
}

export function scopeSummary(auth: McpAuth): string {
  const scope = auth.scope
  const tools = scope.allTools ? 'All tools' : scope.toolNames.join(', ')
  const resources = auth.kind === 'postgres'
    ? (scope.allTables ? 'All tables' : scope.tableNames.join(', '))
    : (scope.allChats ? (auth.kind === 'imap' ? 'All folders' : 'All chats') : scope.chatJids.join(', '))
  return `${tools || 'No tools'} · ${resources || 'No resources'}`
}
