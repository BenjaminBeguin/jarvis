/**
 * Workflow templates for project creation. A template seeds the new
 * project's memory dir with a few markdown files that act as **scaffolds
 * for agent learning** — empty files with prompt headers so the first agent
 * that touches this codebase knows what kind of notes belong where.
 *
 * Memory compounds. The 10th PR review on a project should be sharper than
 * the first; templates give that compounding a starting structure instead
 * of an empty folder.
 *
 * Add a template: drop a file under `./<name>.ts` exporting a
 * `ProjectTemplate` and append it to BUILTIN_TEMPLATES below.
 */

import githubTeam from './github-team.js';
import linearDriven from './linear-driven.js';
import openSourceMaintainer from './open-source-maintainer.js';
import soloIndie from './solo-indie.js';

export interface MemorySeed {
  /** File name under <project>/memory/. ".md" is auto-appended if missing. */
  file: string;
  /** Initial contents. Should include prompt headers (HTML comments) so
   * agents know what kind of notes to append here. */
  content: string;
}

export interface ProjectTemplate {
  /** Stable id ("github-team", "solo-indie", "none"). */
  id: string;
  /** Display label shown in the picker. */
  label: string;
  /** One-line description shown under the label. */
  description: string;
  /** Memory files to seed (only written if they don't already exist). */
  memorySeeds: MemorySeed[];
  /** Skills the user is likely to find useful for this workflow. Surfaced
   * as a hint after project creation; not enforced. */
  recommendedSkills?: string[];
  /** MCP servers that typically pair well with this workflow. */
  recommendedMcps?: string[];
}

export const NONE_TEMPLATE: ProjectTemplate = {
  id: 'none',
  label: 'Just exploring',
  description: 'No seeds — start with an empty memory dir.',
  memorySeeds: [],
};

export const BUILTIN_TEMPLATES: ProjectTemplate[] = [
  NONE_TEMPLATE,
  githubTeam,
  soloIndie,
  linearDriven,
  openSourceMaintainer,
];

export function findTemplate(id: string | null | undefined): ProjectTemplate {
  if (!id) return NONE_TEMPLATE;
  return BUILTIN_TEMPLATES.find((t) => t.id === id) ?? NONE_TEMPLATE;
}
