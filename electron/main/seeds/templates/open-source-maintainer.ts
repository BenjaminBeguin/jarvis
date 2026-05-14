import type { ProjectTemplate } from './index.js';

const openSourceMaintainer: ProjectTemplate = {
  id: 'open-source-maintainer',
  label: 'Open-source maintainer',
  description:
    'Public repo with community contributions, issue triage, release cadence.',
  recommendedSkills: [
    'pr-review-queue',
    'commit-helper',
    'brainstorm',
  ],
  recommendedMcps: ['gh'],
  memorySeeds: [
    {
      file: 'community.md',
      content: `# Community & triage

<!-- Agents: record how you handle community contributions. Examples:
     what a "good first issue" looks like here, how you triage / label,
     when to ask for tests, when to redirect to discussions, your
     response-time norms, contributor agreements / DCO checks. -->
`,
    },
    {
      file: 'releases.md',
      content: `# Release process

<!-- Agents: record the release cadence + mechanics. Examples: semver
     policy, changelog tooling (changesets / conventional commits / hand-
     written), how a release is cut, which branches get patched, how
     security advisories are handled. -->
`,
    },
    {
      file: 'review-bias.md',
      content: `# Review bias

<!-- Agents: PRs to open-source projects have specific review patterns.
     Record yours. Examples: which kinds of changes you welcome vs reject
     by default ("feature requests need an issue first", "no new deps
     without discussion"), code-style hard requirements, things you
     intentionally LEFT a certain way that newcomers often try to
     refactor. -->
`,
    },
  ],
};

export default openSourceMaintainer;
