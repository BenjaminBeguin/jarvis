import type { ProjectTemplate } from './index.js';

const linearDriven: ProjectTemplate = {
  id: 'linear-driven',
  label: 'Linear-driven',
  description:
    'Linear is the source of truth — every change has a ticket; PRs link back.',
  recommendedSkills: [
    'ticket-to-pr',
    'pr-review-queue',
    'pr-address-comments',
    'daily-brief',
  ],
  recommendedMcps: ['linear', 'gh'],
  memorySeeds: [
    {
      file: 'ticket-flow.md',
      content: `# Ticket → branch → PR flow

<!-- Agents: record the conventions this project uses for the ticket-to-PR
     cycle. Examples: branch naming ("ENG-123-short-slug"), commit format,
     when a ticket gets promoted from "todo" to "in progress", whether
     PRs auto-close tickets via keywords. The ticket-to-pr skill uses
     this. -->
`,
    },
    {
      file: 'team-context.md',
      content: `# Team context

<!-- Agents: who-owns-what + Linear conventions. Examples: which team(s)
     this project belongs to, label conventions, project/cycle structure
     in Linear, the difference between "Priority: High" and "Urgent" if
     this org uses them differently from defaults. -->
`,
    },
    {
      file: 'build.md',
      content: `# Build & test

<!-- Agents: record the commands that work in this repo and the gotchas
     you hit. -->
`,
    },
  ],
};

export default linearDriven;
