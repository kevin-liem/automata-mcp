# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

# Project-Specific Guidelines

## Browser and process safety

- Never leave headless browsers, remote-debugging sessions, or dev servers running after a check. A PowerShell/background job reporting "finished" is not proof that a detached browser process exited.
- Use at most one headless browser at a time. For routine visual checks, prefer a one-shot capture with `--headless=new --screenshot=... --virtual-time-budget=...` and a unique disposable `--user-data-dir`.
- Do not use a persistent `--remote-debugging-port` session for routine screenshots. If CDP is unavoidable, put it in a script with a hard timeout, close the browser with `Browser.close`, then explicitly check for leftover processes and listening ports.
- Run headless WebGL only in short, bounded captures. Prefer a modest window size. Use software rendering (`--use-angle=swiftshader`) only when necessary, never for long-lived sessions.
- Before starting a local test, check that no old process is already using the ports. After finishing, verify with `Get-Process chrome,node` and `Get-NetTCPConnection -State Listen` (common ports: 4173, 5173, 9222, 9223).
- Stop managed servers with `job_kill`; do not rely on closing the terminal or the shell job alone.
- Use temporary browser profiles under a temp folder such as `C:\temp\dsh-*`, not inside the workspace. Remove them after the capture when safe.
- If a command hangs, a connection drops, or CPU rises unexpectedly, stop testing immediately, check CPU/processes/ports, and clean up before doing anything else.

## Writing report
- When asked to write a report, only write a brief report explaining what you've done.
- Only put important points, others can find the details themselves.
- Don't write detailed technical numbers unless it's really important.