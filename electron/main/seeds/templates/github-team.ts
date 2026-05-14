import type { ProjectTemplate } from './index.js';

const githubTeam: ProjectTemplate = {
  id: 'github-team',
  label: 'GitHub team',
  description:
    'Multi-author repo with PR review flow, CI gates, and conventional branching.',
  recommendedSkills: ['pr-review-queue', 'pr-address-comments', 'commit-helper'],
  recommendedMcps: ['gh'],
  memorySeeds: [
    {
      file: 'pr-style.md',
      content: `# PR style

<!-- Agents: append observations about this project's PR conventions here.
     Examples: required reviewers, CI gates that must pass, label rules,
     squash vs merge, branch naming, commit-message style, draft-then-ready
     workflow. Update as you learn. Be specific — "we require Reviewer
     approval from someone on @core" beats "PRs need approval". -->
`,
    },
    {
      file: 'build.md',
      content: `# Build & test

<!-- Agents: record the commands that actually work in this repo.
     Examples: \`pnpm install\` vs \`yarn\`, the typecheck command, how to run
     just one test file, common gotchas (rebuild native deps after pulling,
     env vars required, flaky tests to retry). -->
`,
    },
    {
      file: 'team-context.md',
      content: `# Team context

<!-- Agents: record who-owns-what so review/ticket routing is accurate.
     Examples: "@alice owns auth, @bob owns billing"; areas you can self-
     merge vs need review on; on-call rotation if relevant. Useful for
     /send drafts and PR addressing. -->
`,
    },
  ],
};

export default githubTeam;
