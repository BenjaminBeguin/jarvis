/**
 * Default seed for ~/.jarvis/preferences.md. Written on first launch only;
 * the user edits it freely afterwards. Jarvis prepends the file's contents
 * to every task's system prompt, so the rules below shape every agent
 * before any specific skill kicks in.
 *
 * Keep this short. It should be obviously _editable_ — a starting point,
 * not a manifesto. Empty sections are intentional invitations.
 */

export default `# Preferences

Jarvis prepends this file to every task's system prompt. Edit freely —
these are your hard rules and operating preferences. The agent reads
them before any skill, so they shape every action.

## Hard rules

- Never force-push. Never push to main/master directly.
- Ask before deleting files I might still need.
- When in doubt, show me the diff before applying changes.

## How I work

- Use pnpm by default (not npm) when the project supports it.
- TypeScript: strict mode, no \`any\`. Prefer \`unknown\` + narrowing.
- One tight commit per logical change.
- No emojis in commit messages or code comments.

## Style

- Be terse. No preamble like "Great question!" or "I'd be happy to help."
- When showing options, default to the strongest recommendation
  first — don't make me pick between equals.

## What I'm working on

- (Edit this section with your current focus, the side projects you
  context-switch between, the deadlines weighing on you. Agents can
  use this to prioritise relevance when surfacing things.)
`;
