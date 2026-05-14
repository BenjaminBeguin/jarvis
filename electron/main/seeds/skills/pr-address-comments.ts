export default `---
name: pr-address-comments
description: Rebase one of my open PRs from main, fix every review comment, reply to each, push
allowed-tools:
  - Read
  - Edit
  - Write
  - Bash
  - Glob
  - Grep
  - mcp__*
---

You take a PR (mine, with review comments) and work it down to zero
unresolved threads. The shape is: rebase → understand → fix → reply →
commit → push.

## Pick the PR

If the prompt has a PR number or URL, use it. Otherwise:

\`\`\`
gh pr list --author @me --state open --json number,title,headRepository,headRepositoryOwner,url,reviewDecision,comments
\`\`\`

Enumerate and ask which one. If only one open PR, suggest it but
still confirm.

## Resolve the repo + branch

\`\`\`
gh pr view <num> --repo <owner>/<repo> --json headRefName,headRepository,baseRefName
\`\`\`

Resolve the local clone via \`~/.jarvis/projects.json\` if the repo
is registered, otherwise ask where the local checkout lives.

## Load project memory

Glob \`~/.jarvis/projects/<project-slug>/memory/*.md\` (where
\`<project-slug>\` is the project name lowercased with spaces → \`-\`).
Read everything. These are notes from previous agents on this codebase:
conventions, gotchas, things that look broken but aren't. Use them as
authoritative context before reaching for the edits.

## Rebase

1. \`cd\` to the local repo path.
2. Verify clean working tree (\`git status\`). If dirty, STOP and ask.
3. Fetch + rebase onto the latest base branch:
       \`\`\`
       git fetch origin
       git checkout <headRefName>
       git pull --rebase origin <baseRefName>
       \`\`\`
   If conflicts surface, list the files and ask the user how to
   proceed. Never \`-Xtheirs\` or \`-Xours\` automatically.

## Collect comments

\`\`\`
gh api repos/<owner>/<repo>/pulls/<num>/comments --paginate
\`\`\`

Filter to threads that are NOT resolved (the API field varies by
GitHub plan; if you can't tell, treat all as unresolved and rely on
the user to skip). For each comment capture: id, path, line, body,
author.

Also pull general review comments (not inline):

\`\`\`
gh api repos/<owner>/<repo>/issues/<num>/comments --paginate
\`\`\`

Group inline comments by file. Output a short plan:

\`\`\`
## Plan
- src/foo.ts:42 — rename misleading var [from @reviewer]
- src/bar.ts:108 — early-return instead of nested if [from @reviewer]
- (general) clarify rollout sequence in description [from @reviewer]
…
\`\`\`

**Wait for "go"** before editing anything. This is the guardrail
against acting on a misread comment.

## Apply fixes

For each item:
1. Read the file at the line. Understand what the reviewer wants.
2. Make the edit with Edit/Write.
3. If you're not confident the comment is actionable, leave a TODO
   in the code and explain why in the reply — don't fake-fix.

When all edits are done, run the project's typecheck / lint /
quick tests if discoverable (\`pnpm typecheck\`, \`npm run lint\`,
\`pnpm test\`, …). Fix anything that breaks; report what you can't.

## Commit + push

One tight commit. Subject line mentions "review feedback" or
similar; body lists which comments you addressed (so it's a real
paper trail):

\`\`\`
git add -A
git commit -m "review feedback: <one-liner>" -m "$(cat <<'EOF'
- src/foo.ts:42 — renamed X to Y
- src/bar.ts:108 — refactored to early-return
EOF
)"
git push
\`\`\`

Never force-push. If a rebase rewrote history, ask the user
before pushing — they may need to coordinate with their team.

## Reply to each comment

Use the GitHub API to reply in-thread (so the reply nests under the
original comment, not as a fresh comment):

\`\`\`
gh api -X POST \\
  repos/<owner>/<repo>/pulls/<num>/comments/<comment-id>/replies \\
  -f body="Addressed in <commit-sha>: <one-line summary of fix>"
\`\`\`

Or, for general PR comments:

\`\`\`
gh api -X POST repos/<owner>/<repo>/issues/<num>/comments \\
  -f body="..."
\`\`\`

Tone: brief, no apology theatre. "Done — switched to early return."
Not "Great point, thank you so much! I have refactored…"

## Update project memory

After everything pushes cleanly, append a few lines to
\`~/.jarvis/projects/<project-slug>/memory/pr-feedback.md\` (create if
missing). Log **patterns**, not every fix:

- "Reviewers on this repo consistently flag X" → next time, avoid X
  preemptively.
- "Comments often ask for early-return refactors" → take as house
  style.

Memory is for cross-PR patterns. Don't log per-fix.

## Hard rules

- Never merge the PR.
- Never force-push.
- Never resolve a thread you didn't actually address — the reply
  must reference a real commit/change.
- If the comment is asking for a change you disagree with, surface
  that to the user instead of silently doing it.
- Don't touch unrelated code; review feedback only.
`;
