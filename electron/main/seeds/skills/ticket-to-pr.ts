export default `---
name: ticket-to-pr
description: From a meeting selection or short brief, create a Linear ticket + a draft PR in the right repo
allowed-tools:
  - Read
  - Edit
  - Write
  - Bash
  - Glob
  - Grep
  - mcp__*
---

You take a short brief (often a snippet pulled from a live meeting
transcript) and turn it into:
  1. A Linear ticket capturing what needs to change.
  2. A draft PR on the relevant repo with a first-pass implementation.

## Inputs you'll get

The user (or the meeting recorder) hands you a prompt that contains:
- A **highlighted excerpt** — the actual problem statement.
- Optional **full transcript so far** for surrounding context.
- Optional explicit project / repo hint.

If anything is ambiguous, **propose a plan and ask for "go"** before
creating tickets or pushing branches. Don't burn a Linear ticket on a
misunderstood snippet.

## Resolve the project

1. Read \`~/.jarvis/projects.json\`. Match the brief against project names
   + aliases + descriptions. If exactly one project fits, that's it.
   Multiple plausible? Ask. None? Ask.
2. The matched project tells you the local path (\`cd\` target) and repo
   identifier ("owner/name") for \`gh\`.

## Load project memory (READ FIRST)

Before planning, glob \`~/.jarvis/projects/<project-slug>/memory/*.md\`
where \`<project-slug>\` is the project's name lowercased with spaces →
\`-\`. These markdown files are notes left by previous agents about
this codebase — flaky tests, conventions, gotchas, things to avoid.

Use them as authoritative context. If memory says "the integration
tests need a 50ms wait before assertions", do that. If a file
contradicts what you're observing, surface it ("memory said X but the
code now does Y — proceeding with Y, will update memory").

## Step-by-step

1. **Plan** — write a 3-5 line summary: what the change is, why,
   acceptance criteria. Show it to the user. Wait for "go" / "yes" /
   "proceed". This is your guard against acting on a misheard snippet.

2. **Create the Linear ticket** via \`mcp__linear__save_issue\` (or
   whatever your Linear MCP exposes). Title: short imperative. Body:
   the plan + relevant excerpt as a quote. Assign to the current user
   if you can resolve them; otherwise leave unassigned. Capture the
   resulting ticket URL.

3. **Open the repo** — \`cd\` to the project's local path. Pull main.
   Create a feature branch named after the ticket (\`<team>-<num>-<slug>\`).

4. **Make the change** — for small, well-scoped tickets, do the actual
   edits with Read/Edit/Write/Glob. For anything larger, write a
   placeholder commit (\`TODO(<ticket-id>): <one-liner>\`) and a
   detailed body explaining what needs to happen, so the PR is a real
   handoff instead of a fake one. Either way, run the project's lint /
   typecheck if obvious (\`pnpm typecheck\`, \`npm run lint\`, etc.) and
   fix what's auto-fixable.

5. **Commit + push** — single tight commit with the ticket id in the
   message. Push to the remote.

6. **Open the PR** via \`gh pr create\` with a body that links the
   Linear ticket. Mark as draft if the change is a stub.

7. **Save project memory.** Append to
   \`~/.jarvis/projects/<project-slug>/memory/<topic>.md\` (one file per
   area of the codebase you touched — e.g. \`auth.md\`, \`build.md\`).
   Each entry should be a few lines, dated, focused on the
   **non-obvious things** future agents will need:

   - Conventions you had to follow ("this codebase uses Vitest, not Jest").
   - Gotchas you hit ("integration tests need a 50ms wait before assertions").
   - Architectural decisions you observed ("auth flows go through the
     UserSession singleton — don't add new auth paths").
   - Caveats that aren't in the code or README.

   Skip the obvious. Don't write "the project uses TypeScript".

8. **Report back** — output a short markdown block:
       \`\`\`
       ✅ Ticket: <linear url>
       ✅ Branch: <branch>
       ✅ PR (draft): <pr url>
       📝 Memory: <files touched>
       \`\`\`
   If any step failed, surface the error verbatim and stop.

## Hard rules

- Never push to main / master directly.
- Never force-push.
- Don't merge the PR — humans do that.
- If the repo has \`CLAUDE.md\` or similar agent guidance, read it first
  and respect it.
- If the change touches > ~5 files or a security-sensitive area
  (auth, payment, env vars, infra config), STOP after the plan and
  ask before editing.
`;
