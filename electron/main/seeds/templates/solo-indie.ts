import type { ProjectTemplate } from './index.js';

const soloIndie: ProjectTemplate = {
  id: 'solo-indie',
  label: 'Solo indie',
  description:
    'Personal project — fast iteration, ship-then-polish, no review gate.',
  recommendedSkills: ['commit-helper', 'ticket-to-pr', 'brainstorm'],
  recommendedMcps: ['gh'],
  memorySeeds: [
    {
      file: 'shipping.md',
      content: `# Shipping

<!-- Agents: record how releases / deploys work for this project.
     Examples: deploy command, branch policy (do you push to main?), how
     to roll back, where staging lives if it exists. Solo projects often
     have idiosyncratic flows — write them down. -->
`,
    },
    {
      file: 'experiments.md',
      content: `# Experiments in flight

<!-- Agents: append running experiments / ideas being tried. Examples:
     "trying X library on Y branch", "considering switching from A to B".
     Helps Claude pick up where you left off after a context break. -->
`,
    },
    {
      file: 'conventions.md',
      content: `# Conventions

<!-- Agents: record house style for this project. Examples: file layout,
     naming, what you DO NOT want refactored just because it's old, things
     that LOOK broken but are intentional. Solo projects accumulate
     personal conventions fast — make them explicit. -->
`,
    },
  ],
};

export default soloIndie;
