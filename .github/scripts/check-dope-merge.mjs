import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const notesPath = 'docs/main-dope-differences.md'
const [base, head] = process.argv.slice(2)

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

if (Boolean(base) !== Boolean(head)) {
  console.error('Usage: node .github/scripts/check-dope-merge.mjs [<base> <head>]')
  process.exit(2)
}

const mainRefs = git('for-each-ref', '--format=%(refname)', 'refs/heads/main', 'refs/remotes/origin/main')
  .split('\n').filter(Boolean)
if (!mainRefs.length) process.exit(0)

// First-parent history distinguishes main's merge points from feature branches
// merged upstream. Check only main history that the target doesn't have yet.
const mainHistory = new Set(git('rev-list', '--first-parent', ...mainRefs, '--not', base ?? 'HEAD').split('\n'))
mainHistory.delete('')
if (!mainHistory.size) process.exit(0)

// The range excludes upstream's own merge commits.
const incomingParents = head
  ? git('log', '--merges', '--format=%P', `${base}..${head}`, '--not', ...mainRefs)
    .split('\n').flatMap(parents => parents.split(' ').slice(1))
  : readFileSync(git('rev-parse', '--git-path', 'MERGE_HEAD'), 'utf8').trim().split(/\s+/)
const mainMerges = new Set(incomingParents.filter(parent => mainHistory.has(parent)))

if (head) {
  // A push can bring in main by fast-forward without a second parent.
  const fastForwardTip = git('rev-list', '--first-parent', `${base}..${head}`)
    .split('\n').find(commit => mainHistory.has(commit))
  if (fastForwardTip) mainMerges.add(fastForwardTip)
}

if (!mainMerges.size) process.exit(0)

const notes = git('show', `${head ?? ''}:${notesPath}`)
const entries = new Set(Array.from(
  notes.matchAll(/^### Main `([0-9a-f]{40})`\r?\n(?:[ \t]*\r?\n)*- \S/gm),
  match => match[1],
))

for (const commit of mainMerges) {
  if (entries.has(commit)) continue
  console.error(`In ${notesPath}, add an entry headed "### Main \`${commit}\`" with a bullet describing the merge.`)
  process.exitCode = 1
}
