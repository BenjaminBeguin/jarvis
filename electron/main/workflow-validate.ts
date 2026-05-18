import cron from 'node-cron';

import type { WorkflowDef, WorkflowNodeDef } from '@shared/types';

import type { McpConfigStore } from './mcp-config.js';
import type { SkillStore } from './skill-store.js';
import { NODE_REGISTRY } from './workflow-nodes/index.js';

/**
 * Catch broken workflow references at save time instead of at the
 * next cron fire. Splits findings into:
 *
 *   - `errors`   — the workflow can't possibly work as-authored
 *                   (unknown node type, malformed cron, transform
 *                   that doesn't parse). Save is refused.
 *   - `warnings` — the workflow might work, but something looks off
 *                   (skill id not found, MCP server not registered,
 *                   inbox-write to a reserved source). Save proceeds.
 *
 * The reasoning behind the split: an MCP not being registered at
 * authoring time is a legitimate "I'll connect it next" state. A
 * transform with a syntax error is just broken.
 */

export interface WorkflowValidationResult {
  errors: string[];
  warnings: string[];
}

const RESERVED_INBOX_SOURCES = new Set([
  'linear',
  'slack',
  'calendar',
  // 'smart' is reserved-but-intended for the inbox-curate skill —
  // we don't error if a user wires a workflow there directly, but
  // warn so they know it shadows the curator output.
]);

const SHORTHAND_RE = /^(\d+)\s*(s|sec|m|min|h|hr|d|day)s?$/i;

/**
 * Mirror of WorkflowScheduler.expandEvery's logic, minus the
 * `{businessHours}` substitution (that resolves at fire time;
 * validation just trusts it). Returns null if we can't even guess.
 */
function expandForValidation(every: string): string | null {
  const trimmed = every.trim();
  if (trimmed.split(/\s+/).length >= 4) return trimmed;
  // We can't expand `{businessHours}` here — replace it with a
  // plausible 5-field cron tail for the validator.
  if (trimmed.includes('{businessHours}')) {
    return trimmed.replace(/\{businessHours\}/g, '9-18 * * 1-5');
  }
  const m = SHORTHAND_RE.exec(trimmed);
  if (!m) return trimmed; // pass through; cron.validate will catch it
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  if (unit === 's' || unit === 'sec') return `*/1 * * * *`;
  if (unit === 'm' || unit === 'min')
    return `*/${Math.min(Math.max(n, 1), 59)} * * * *`;
  if (unit === 'h' || unit === 'hr')
    return `0 */${Math.min(Math.max(n, 1), 23)} * * *`;
  if (unit === 'd' || unit === 'day')
    return `0 0 */${Math.min(Math.max(n, 1), 7)} * *`;
  return trimmed;
}

export function validateWorkflow(
  def: WorkflowDef,
  deps: { skills: SkillStore; mcp: McpConfigStore },
): WorkflowValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Basic shape — the store already enforces id + name + trigger,
  // but a save() bypass (e.g. a malformed JSON edit) could land
  // here. Belt-and-suspenders.
  if (!def.id || typeof def.id !== 'string') errors.push('id is required');
  if (!def.name || typeof def.name !== 'string')
    errors.push('name is required');
  if (!def.trigger || typeof def.trigger !== 'object')
    errors.push('trigger is required');

  // Trigger checks.
  if (def.trigger?.kind === 'cron') {
    if (!def.trigger.every || typeof def.trigger.every !== 'string') {
      errors.push('cron trigger needs an "every" expression');
    } else {
      const expanded = expandForValidation(def.trigger.every);
      if (expanded && !cron.validate(expanded)) {
        errors.push(
          `cron expression "${def.trigger.every}" → "${expanded}" is not a valid 5-field cron`,
        );
      }
    }
  } else if (def.trigger?.kind === 'manual') {
    // No fields are required; palette field is optional.
  } else if (def.trigger) {
    errors.push(`unknown trigger kind: ${String((def.trigger as { kind?: unknown }).kind)}`);
  }

  if (!Array.isArray(def.pipeline)) {
    errors.push('pipeline must be an array');
  } else if (def.pipeline.length === 0) {
    warnings.push('pipeline is empty — runs will be no-ops');
  } else {
    def.pipeline.forEach((node, i) => {
      const issues = validateNode(node, i, deps);
      errors.push(...issues.errors);
      warnings.push(...issues.warnings);
    });
  }

  return { errors, warnings };
}

interface NodeIssues {
  errors: string[];
  warnings: string[];
}

function validateNode(
  node: WorkflowNodeDef,
  index: number,
  deps: { skills: SkillStore; mcp: McpConfigStore },
): NodeIssues {
  const errors: string[] = [];
  const warnings: string[] = [];
  const where = `step ${index + 1} (${node.type ?? '?'})`;

  if (!node.type || typeof node.type !== 'string') {
    errors.push(`${where}: type is required`);
    return { errors, warnings };
  }
  if (!NODE_REGISTRY[node.type]) {
    errors.push(
      `${where}: unknown node type "${node.type}". Known: ${Object.keys(NODE_REGISTRY).join(', ')}`,
    );
    return { errors, warnings };
  }

  const p = (node.params ?? {}) as Record<string, unknown>;

  switch (node.type) {
    case 'http-fetch': {
      if (typeof p.url !== 'string' || !p.url.trim()) {
        errors.push(`${where}: params.url is required`);
        break;
      }
      try {
        new URL(p.url);
      } catch {
        // Doesn't have to be a literal URL — could be templated by a
        // previous step. Warn only.
        warnings.push(`${where}: params.url "${p.url}" doesn't parse as a URL`);
      }
      if (typeof p.validate === 'string') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          new Function('$', `return (${p.validate})`);
        } catch (e) {
          errors.push(
            `${where}: validate expression doesn't parse — ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      break;
    }

    case 'transform': {
      if (typeof p.fn !== 'string' || !p.fn.trim()) {
        errors.push(`${where}: params.fn is required`);
        break;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        new Function('$', `return (${p.fn})`);
      } catch (e) {
        errors.push(
          `${where}: transform fn doesn't parse — ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      break;
    }

    case 'osascript': {
      if (typeof p.script !== 'string' || !p.script.trim()) {
        errors.push(`${where}: params.script is required`);
      }
      if (
        p.language !== undefined &&
        p.language !== 'applescript' &&
        p.language !== 'javascript'
      ) {
        errors.push(
          `${where}: params.language must be 'applescript' or 'javascript'`,
        );
      }
      break;
    }

    case 'shell': {
      if (typeof p.cmd !== 'string' || !p.cmd.trim()) {
        errors.push(`${where}: params.cmd is required`);
      }
      break;
    }

    case 'inbox-write': {
      if (typeof p.source !== 'string' || !p.source.trim()) {
        errors.push(`${where}: params.source is required`);
      } else if (RESERVED_INBOX_SOURCES.has(p.source)) {
        warnings.push(
          `${where}: inbox source "${p.source}" is the name of a built-in workflow — writing here will conflict`,
        );
      }
      if (typeof p.label !== 'string' || !p.label.trim()) {
        warnings.push(
          `${where}: params.label is empty — the section header will be the source id`,
        );
      }
      break;
    }

    case 'notify': {
      if (typeof p.title !== 'string' || !p.title.trim()) {
        warnings.push(`${where}: params.title is empty`);
      }
      break;
    }

    case 'run-skill': {
      if (typeof p.skillId !== 'string' || !p.skillId.trim()) {
        errors.push(`${where}: params.skillId is required`);
        break;
      }
      const skill = deps.skills.list().find((s) => s.id === p.skillId);
      if (!skill) {
        warnings.push(
          `${where}: skill "${p.skillId}" not found. Did you drop a SKILL.md under ~/.jarvis/skills/${p.skillId}/?`,
        );
      }
      break;
    }

    case 'mcp-call': {
      if (typeof p.mcp !== 'string' || !p.mcp.trim()) {
        errors.push(`${where}: params.mcp is required (the server id)`);
        break;
      }
      if (typeof p.tool !== 'string' || !p.tool.trim()) {
        errors.push(`${where}: params.tool is required`);
      }
      const resolved = deps.mcp.resolve([p.mcp])[p.mcp];
      if (!resolved) {
        warnings.push(
          `${where}: MCP server "${p.mcp}" isn't registered. Add it under Settings → Integrations or wait for the connector to come online.`,
        );
      }
      break;
    }

    default:
      // Unknown registered node — covered by NODE_REGISTRY check above.
      break;
  }

  return { errors, warnings };
}
