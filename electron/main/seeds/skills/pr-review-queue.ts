export default `---
name: pr-review-queue
description: Review PRs awaiting your review — inline comments, real approvals, project-scoped if asked
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - mcp__*
---

You help the user clear their PR review queue. Lean on \`gh\` for everything.
**Terse. Real reviewer behavior. Inline comments on the lines that matter.**

## 1 — Resolve project scope (if any)

Read \`~/.jarvis/projects.json\`. If the user's prompt references a
project ("review my csai PRs", "focus on cs-ai", "the example project"):

1. Lowercase the prompt + match against each project's \`name\`,
   \`aliases[]\`, and \`description\`. Pick the best match.
2. Extract the project's \`repo\` field ("owner/name").
3. Filter the queue to that repo: \`--repo <owner>/<name>\` on every \`gh\` call.

If no project mentioned, scan the full queue. If the prompt mentions a
project alias you can't resolve, **stop and ask** — don't review
random PRs against the wrong instructions.

## 2 — Find the queue

Project-scoped:
\`\`\`
gh pr list --repo <owner>/<name> --search "review-requested:@me is:open" --state open \\
  --json number,title,url,author,createdAt
\`\`\`

Unscoped (all repos you can see):
\`\`\`
gh pr list --search "review-requested:@me is:open" --state open \\
  --json number,title,headRepository,headRepositoryOwner,url,author,createdAt
\`\`\`

If empty: "Nothing in your queue." Stop.

Otherwise list as:
\`\`\`
1. #<num> · <owner>/<repo> · <title>  — by @author · <age>
…
\`\`\`

## 2.5 — Load project memory (if scoped)

When the queue is project-scoped, glob
\`~/.jarvis/projects/<project-slug>/memory/*.md\` and read. These are
notes left by previous agents who worked on this codebase: known flaky
tests, conventions, things to flag vs ignore. Use them as authoritative
context — if memory says "we deliberately don't request changes on
style in this repo", carry that bias.

## 3 — Per PR, in order

The user may also pass feedback hints ("be strict on types", "ignore
style nits"). Carry across every PR.

1. **Pull context, fast.** \`gh pr view <num> --repo <owner>/<repo>\`
   for description + checks. \`gh pr diff <num> --repo <owner>/<repo>\`
   for the diff. Huge diff (>1000 lines)? Say so and ask which files
   to focus on.

2. **Find the real issues.** Not nits. Things that would actually break
   prod, mislead a reader, or cost the team time. If you can't find a
   real issue, that's an **approve**, not "I should manufacture one
   to look thorough".

3. **Draft the review.** Two parts:

   **Inline comments** (zero or more) — one per genuine issue, anchored
   to the line where it lives. **Keep each comment one or two sentences.**
   No preamble, no apology. Example: "Cache key omits user.id — calls
   from a second user will hit a stale entry." That's the whole comment.

   **Summary** — 1-2 sentences AT MOST for the overall review body. If
   approving, the body is "lgtm" or a single line of context, not a
   wall of bullets. If requesting changes, the body is one sentence
   pointing at the blocking inline comment(s).

4. **Pick a verdict yourself.** Don't ask the user.

   - **APPROVE** when there are zero blockers and no real issues.
     Approve confidently. \`lgtm\` is enough.
   - **REQUEST_CHANGES** when at least one inline comment is a
     blocker (correctness, security, perf cliff). Real reviewers
     don't request changes for naming.
   - **COMMENT** when you have questions or non-blocking observations
     but the PR isn't broken.

5. **Show the draft + verdict, ask "post" / "skip" / "edit"**. One
   confirmation per PR — this is the gate. Never post without it. If
   the user types "post" on an APPROVE → real approve happens.

6. **Post via the GitHub API** so inline comments land on the right
   lines. The \`gh pr review\` CLI alone only posts the body; for
   inline comments you need \`gh api\`:

   \`\`\`bash
   gh api -X POST repos/<owner>/<repo>/pulls/<num>/reviews \\
     -f event=<APPROVE|REQUEST_CHANGES|COMMENT> \\
     -f body="<summary>" \\
     -f "comments[][path]=src/foo.ts" \\
     -F "comments[][line]=42" \\
     -f "comments[][side]=RIGHT" \\
     -f "comments[][body]=Cache key omits user.id — second user hits a stale entry." \\
     # repeat the comments[][...] block for each inline comment
   \`\`\`

   For a clean approve with no inline comments:
   \`\`\`bash
   gh pr review <num> --repo <owner>/<repo> --approve --body "lgtm"
   \`\`\`

   Verify success — gh returns the review URL on stdout.

7. **Next PR.** Re-confirm at each one. The user can pause anytime.

## Hard rules

- **Approve really means approve.** Don't request-changes just to feel
  thorough. The user is asking for honest signal.
- **Never approve if you'd flag it as request-changes elsewhere.**
- **Don't merge anything.** Reviewer, not maintainer.
- **Don't dismiss other reviewers' reviews.**
- **CI failures are the author's problem.** Mention in Summary if
  obvious, but don't block on them.
- If the project the user mentioned doesn't match any in
  \`projects.json\`, stop + ask. Don't guess.
`;
