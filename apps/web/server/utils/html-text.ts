import { convert } from 'html-to-text'

/**
 * An email's HTML body as plain text, at a cost linear in its length.
 *
 * html-to-text parses with htmlparser2, whose Parser keeps open elements in an
 * array it grows with `unshift` and searches with `indexOf` on every close tag,
 * and keeps a second "foreign context" array the same way. Both cost the
 * array's length per tag, so a body of unclosed tags (`<div>` repeated) or of
 * `<div><svg></div>` repeated parses in time quadratic in its size: 2 MiB from
 * an outside sender froze the shared event loop for ~30 s per read
 * (GHSA-jw4m-6vvp-36rg). Byte caps bound size, not that.
 *
 * So `nestingDepth` replays the parser's stack rules over the tokenizer's
 * rules, with push/pop, in one linear pass. Within `MAX_NESTING` the body goes
 * to html-to-text untouched — same output as before. Past it, the body is
 * flattened first: text kept, every tag dropped, so nothing nests at all.
 *
 * The pass must agree with htmlparser2 on where tags start and end, or a body
 * could hide opening tags from it (inside a quoted attribute, a comment, a
 * `<script>`) while still nesting in the real parse. Hence a port of the
 * tokenizer's states rather than a regex — a regex like /<[^>]*>/ is itself
 * quadratic on `<a` repeated with no `>`. Written against htmlparser2 10.1.0;
 * a bump of html-to-text or htmlparser2 = re-check the port.
 */

/** Deeper than any real email; low enough that N tags x this depth stays fast. */
const MAX_NESTING = 256

const OPTIONS = { wordwrap: false as const, selectors: [{ selector: 'img', format: 'skip' }] }

export function htmlToText(html: string): string {
  return convert(nestingDepth(html, MAX_NESTING) > MAX_NESTING ? flattenHtml(html) : html, OPTIONS)
}

// --- htmlparser2's Parser stack rules (Parser.js) -----------------------------

const pTag = new Set(['p'])
const formTags = new Set(['input', 'option', 'optgroup', 'select', 'button', 'datalist', 'textarea'])
const tableSectionTags = new Set(['thead', 'tbody'])
const ddtTags = new Set(['dd', 'dt'])
const rtpTags = new Set(['rt', 'rp'])
const OPEN_IMPLIES_CLOSE = new Map<string, Set<string>>([
  ['tr', new Set(['tr', 'th', 'td'])], ['th', new Set(['th'])], ['td', new Set(['thead', 'th', 'td'])],
  ['body', new Set(['head', 'link', 'script'])], ['li', new Set(['li'])],
  ['p', pTag], ['h1', pTag], ['h2', pTag], ['h3', pTag], ['h4', pTag], ['h5', pTag], ['h6', pTag],
  ['select', formTags], ['input', formTags], ['output', formTags], ['button', formTags],
  ['datalist', formTags], ['textarea', formTags],
  ['option', new Set(['option'])], ['optgroup', new Set(['optgroup', 'option'])],
  ['dd', ddtTags], ['dt', ddtTags],
  ['address', pTag], ['article', pTag], ['aside', pTag], ['blockquote', pTag], ['details', pTag],
  ['div', pTag], ['dl', pTag], ['fieldset', pTag], ['figcaption', pTag], ['figure', pTag],
  ['footer', pTag], ['form', pTag], ['header', pTag], ['hr', pTag], ['main', pTag], ['nav', pTag],
  ['ol', pTag], ['pre', pTag], ['section', pTag], ['table', pTag], ['ul', pTag],
  ['rt', rtpTags], ['rp', rtpTags], ['tbody', tableSectionTags], ['tfoot', tableSectionTags],
])
const VOID = new Set([
  'area', 'base', 'basefont', 'br', 'col', 'command', 'embed', 'frame', 'hr', 'img', 'input',
  'isindex', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr',
])
const FOREIGN = new Set(['math', 'svg'])
const INTEGRATION = new Set(['mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml', 'foreignobject', 'desc', 'title'])

/**
 * The parser's two arrays, top at the end instead of the front, so every step
 * is O(1) amortised: a close tag pops at least as many entries as it scans,
 * and `counts` answers "not open" without scanning at all.
 */
class NestingTracker {
  private stack: string[] = []
  private counts = new Map<string, number>()
  private foreign: boolean[] = [false]
  private tagname = ''
  max = 0

  private push(name: string) {
    this.stack.push(name)
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1)
  }

  private pop(): string {
    const name = this.stack.pop()!
    this.counts.set(name, this.counts.get(name)! - 1)
    return name
  }

  open(name: string) {
    this.tagname = name
    const implies = OPEN_IMPLIES_CLOSE.get(name)
    if (implies) {
      while (this.stack.length > 0 && implies.has(this.stack[this.stack.length - 1]!)) this.pop()
    }
    if (!VOID.has(name)) {
      this.push(name)
      if (FOREIGN.has(name)) this.foreign.push(true)
      else if (INTEGRATION.has(name)) this.foreign.push(false)
      this.max = Math.max(this.max, this.stack.length, this.foreign.length)
    }
  }

  /** `<x/>`: honoured only in foreign (svg, math) context, as the parser does in HTML mode. */
  selfClosing() {
    if (this.foreign[this.foreign.length - 1] && this.stack[this.stack.length - 1] === this.tagname) this.pop()
    this.tagname = ''
  }

  openEnd() {
    this.tagname = ''
  }

  close(name: string) {
    // The parser shifts this array on every such close tag, open or not.
    if (FOREIGN.has(name) || INTEGRATION.has(name)) this.foreign.pop()
    if (VOID.has(name)) return
    if (this.counts.get(name)) {
      while (this.pop() !== name) { /* pops through the topmost `name` */ }
    }
    // `</p>` with no open p opens and closes one: no net change, one more for a moment.
    else if (name === 'p') this.max = Math.max(this.max, this.stack.length + 1)
  }
}

// --- htmlparser2's Tokenizer states (Tokenizer.js), entities ignored --------
// Entity decoding never consumes `<`, `>`, quotes or whitespace, so skipping
// it cannot move a tag boundary.

const S = {
  Text: 1, BeforeTagName: 2, InTagName: 3, InSelfClosingTag: 4, BeforeClosingTagName: 5,
  InClosingTagName: 6, AfterClosingTagName: 7, BeforeAttributeName: 8, InAttributeName: 9,
  AfterAttributeName: 10, BeforeAttributeValue: 11, InAttributeValueDq: 12, InAttributeValueSq: 13,
  InAttributeValueNq: 14, BeforeDeclaration: 15, InDeclaration: 16, InProcessingInstruction: 17,
  BeforeComment: 18, CDATASequence: 19, InSpecialComment: 20, InCommentLike: 21,
  BeforeSpecialS: 22, BeforeSpecialT: 23, SpecialStartSequence: 24, InSpecialTag: 25,
} as const

const seq = (s: string) => Array.from(s, ch => ch.charCodeAt(0))
const CDATA = seq('CDATA[')
const CDATA_END = seq(']]>')
const COMMENT_END = seq('-->')
const SCRIPT_END = seq('</script')
const STYLE_END = seq('</style')
const TITLE_END = seq('</title')
const TEXTAREA_END = seq('</textarea')
const XMP_END = seq('</xmp')

const isWhitespace = (c: number) => c === 32 || c === 10 || c === 9 || c === 12 || c === 13
const isEndOfTagSection = (c: number) => c === 47 || c === 62 || isWhitespace(c)
const isAlpha = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90)

interface TokenSink {
  /** Text between tags; `raw` names the end sequence when inside script/style/title/textarea/xmp. */
  text(start: number, end: number, raw?: number[]): void
  open(name: string): void
  openEnd(): void
  selfClosing(): void
  close(name: string): void
  /** Return true to stop early. */
  done?(): boolean
}

function tokenize(html: string, sink: TokenSink) {
  const len = html.length
  let state: number = S.Text
  let sectionStart = 0
  let sequence: number[] = COMMENT_END
  let seqIdx = 0
  let isSpecial = false

  // Index of the next `ch` after `i`, or the last index when there is none —
  // the tokenizer's fastForwardTo. indexOf keeps every skip linear.
  const forwardTo = (ch: string, i: number): [number, boolean] => {
    const j = html.indexOf(ch, i + 1)
    return j === -1 ? [len - 1, false] : [j, true]
  }

  for (let i = 0; i < len; i++) {
    const c = html.charCodeAt(i)
    // Some states reconsume the character in the next state; loop until one keeps it.
    for (;;) {
      switch (state) {
        case S.Text:
          if (c === 60) {
            if (i > sectionStart) sink.text(sectionStart, i)
            state = S.BeforeTagName
            sectionStart = i
          }
          break
        case S.BeforeTagName:
          if (c === 33) { state = S.BeforeDeclaration; sectionStart = i + 1 }
          else if (c === 63) { state = S.InProcessingInstruction; sectionStart = i + 1 }
          else if (isAlpha(c)) {
            sectionStart = i
            const lower = c | 0x20
            state = lower === 0x73 ? S.BeforeSpecialS : lower === 0x74 || lower === 0x78 ? S.BeforeSpecialT : S.InTagName
          }
          else if (c === 47) state = S.BeforeClosingTagName
          else { state = S.Text; continue }
          break
        case S.BeforeSpecialS: {
          const lower = c | 0x20
          if (lower === SCRIPT_END[3]) { isSpecial = true; sequence = SCRIPT_END; seqIdx = 4; state = S.SpecialStartSequence }
          else if (lower === STYLE_END[3]) { isSpecial = true; sequence = STYLE_END; seqIdx = 4; state = S.SpecialStartSequence }
          else { state = S.InTagName; continue }
          break
        }
        case S.BeforeSpecialT: {
          const lower = c | 0x20
          if (lower === TITLE_END[3]) { isSpecial = true; sequence = TITLE_END; seqIdx = 4; state = S.SpecialStartSequence }
          else if (lower === TEXTAREA_END[3]) { isSpecial = true; sequence = TEXTAREA_END; seqIdx = 4; state = S.SpecialStartSequence }
          else if (lower === XMP_END[3]) { isSpecial = true; sequence = XMP_END; seqIdx = 4; state = S.SpecialStartSequence }
          else { state = S.InTagName; continue }
          break
        }
        case S.SpecialStartSequence: {
          const isEnd = seqIdx === sequence.length
          const isMatch = isEnd ? isEndOfTagSection(c) : (c | 0x20) === sequence[seqIdx]
          if (!isMatch) isSpecial = false
          else if (!isEnd) { seqIdx++; break }
          seqIdx = 0
          state = S.InTagName
          continue
        }
        case S.InTagName:
          if (isEndOfTagSection(c)) {
            sink.open(html.slice(sectionStart, i).toLowerCase())
            sectionStart = -1
            state = S.BeforeAttributeName
            continue
          }
          break
        case S.BeforeAttributeName:
          if (c === 62) {
            sink.openEnd()
            if (isSpecial) { state = S.InSpecialTag; seqIdx = 0 }
            else state = S.Text
            sectionStart = i + 1
          }
          else if (c === 47) state = S.InSelfClosingTag
          else if (!isWhitespace(c)) { state = S.InAttributeName; sectionStart = i }
          break
        case S.InSelfClosingTag:
          if (c === 62) {
            sink.selfClosing()
            state = S.Text
            sectionStart = i + 1
            isSpecial = false
          }
          else if (!isWhitespace(c)) { state = S.BeforeAttributeName; continue }
          break
        case S.InAttributeName:
          if (c === 61 || isEndOfTagSection(c)) { state = S.AfterAttributeName; continue }
          break
        case S.AfterAttributeName:
          if (c === 61) state = S.BeforeAttributeValue
          else if (c === 47 || c === 62) { state = S.BeforeAttributeName; continue }
          else if (!isWhitespace(c)) state = S.InAttributeName
          break
        case S.BeforeAttributeValue:
          if (c === 34) state = S.InAttributeValueDq
          else if (c === 39) state = S.InAttributeValueSq
          else if (!isWhitespace(c)) { state = S.InAttributeValueNq; continue }
          break
        case S.InAttributeValueDq:
          if (c === 34) state = S.BeforeAttributeName
          break
        case S.InAttributeValueSq:
          if (c === 39) state = S.BeforeAttributeName
          break
        case S.InAttributeValueNq:
          if (isWhitespace(c) || c === 62) { state = S.BeforeAttributeName; continue }
          break
        case S.BeforeClosingTagName:
          if (isWhitespace(c)) { /* ignored */ }
          else if (c === 62) state = S.Text
          else { state = isAlpha(c) ? S.InClosingTagName : S.InSpecialComment; sectionStart = i }
          break
        case S.InClosingTagName:
          if (c === 62 || isWhitespace(c)) {
            sink.close(html.slice(sectionStart, i).toLowerCase())
            sectionStart = -1
            state = S.AfterClosingTagName
            continue
          }
          break
        case S.AfterClosingTagName:
        case S.InDeclaration:
        case S.InProcessingInstruction:
        case S.InSpecialComment:
          if (c !== 62) {
            const [j, found] = forwardTo('>', i)
            i = j
            if (!found) break
          }
          state = S.Text
          sectionStart = i + 1
          break
        case S.BeforeDeclaration:
          if (c === 91) { state = S.CDATASequence; seqIdx = 0 }
          else state = c === 45 ? S.BeforeComment : S.InDeclaration
          break
        case S.BeforeComment:
          if (c === 45) { state = S.InCommentLike; sequence = COMMENT_END; seqIdx = 2; sectionStart = i + 1 }
          else state = S.InDeclaration
          break
        case S.CDATASequence:
          if (c === CDATA[seqIdx]) {
            if (++seqIdx === CDATA.length) { state = S.InCommentLike; sequence = CDATA_END; seqIdx = 0; sectionStart = i + 1 }
            break
          }
          seqIdx = 0
          state = S.InDeclaration
          continue
        case S.InCommentLike:
          if (c === sequence[seqIdx]) {
            if (++seqIdx === sequence.length) { seqIdx = 0; sectionStart = i + 1; state = S.Text }
          }
          else if (seqIdx === 0) {
            const [j, found] = forwardTo(String.fromCharCode(sequence[0]!), i)
            i = j
            if (found) seqIdx = 1
          }
          else if (c !== sequence[seqIdx - 1]) seqIdx = 0
          break
        case S.InSpecialTag:
          if (seqIdx === sequence.length) {
            if (c === 62 || isWhitespace(c)) {
              const endOfText = i - sequence.length
              if (sectionStart < endOfText) sink.text(sectionStart, endOfText, sequence)
              isSpecial = false
              sectionStart = endOfText + 2
              state = S.InClosingTagName
              continue
            }
            seqIdx = 0
          }
          if ((c | 0x20) === sequence[seqIdx]) seqIdx++
          else if (seqIdx === 0) {
            if (sequence !== TITLE_END) {
              // Only an exact `<` counts here, unlike the comparison above.
              const [j, found] = forwardTo('<', i)
              i = j
              if (found) seqIdx = 1
            }
          }
          else seqIdx = Number(c === 60)
          break
      }
      break
    }
    if (sink.done?.()) return
  }

  // The tokenizer's cleanup + handleTrailingData: an unfinished tag is dropped,
  // an unfinished comment is a comment, anything else left over is text.
  if (sectionStart >= 0 && sectionStart < len) {
    if (state === S.InSpecialTag) sink.text(sectionStart, len, sequence)
    else if (state !== S.InCommentLike && !(
      state === S.InTagName || state === S.BeforeAttributeName || state === S.BeforeAttributeValue
      || state === S.AfterAttributeName || state === S.InAttributeName || state === S.InAttributeValueSq
      || state === S.InAttributeValueDq || state === S.InAttributeValueNq || state === S.InClosingTagName
    )) sink.text(sectionStart, len)
  }
}

/**
 * The most open elements (or foreign-context entries) htmlparser2 would hold
 * at once while parsing `html`; stops counting once past `stopAbove`.
 */
export function nestingDepth(html: string, stopAbove = Number.POSITIVE_INFINITY): number {
  const tracker = new NestingTracker()
  tokenize(html, {
    text() {},
    open: name => tracker.open(name),
    openEnd: () => tracker.openEnd(),
    selfClosing: () => tracker.selfClosing(),
    close: name => tracker.close(name),
    done: () => tracker.max > stopAbove,
  })
  return tracker.max
}

const BREAKING = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav',
  'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])

/**
 * `html` with every tag removed, so it parses flat. Text is kept with its
 * entities (html-to-text still decodes them) and every `<` escaped, so pieces
 * joined across a removed tag cannot form a new one. Block-level tags become
 * one `<br>` per run, which keeps paragraphs apart without nesting anything.
 * Script, style and title contents are dropped, as html-to-text drops them.
 */
function flattenHtml(html: string): string {
  const out: string[] = []
  let pendingBreak = false
  const mark = (name: string) => { if (BREAKING.has(name)) pendingBreak = true }
  tokenize(html, {
    text(start, end, raw) {
      if (raw === SCRIPT_END || raw === STYLE_END || raw === TITLE_END) return
      if (pendingBreak && out.length > 0) out.push('<br>')
      pendingBreak = false
      out.push(html.slice(start, end).replaceAll('<', '&lt;'))
    },
    open: mark,
    openEnd() {},
    selfClosing() {},
    close: mark,
  })
  return out.join('')
}
