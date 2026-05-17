import type { Module } from './types.js';

/**
 * Workflows module — exposes the `/wf` palette intent.
 *
 *   /wf                  → lists every workflow with its id + trigger
 *   /wf <workflow-id>    → fires that workflow manually (origin=manual)
 *
 * The module doesn't auto-register one intent per workflow because the
 * Module shape is static — intents are read at load time. A single
 * dispatch-by-id intent gives the same outcome with one slot in the
 * palette. The same access path is wired into the Jarvis MCP server
 * (`mcp__jarvis__list_workflows` + `mcp__jarvis__run_workflow`) so
 * agents inside skills can launch workflows too.
 */
export const workflowsModule: Module = {
  id: 'workflows',
  name: 'Workflows',
  description:
    'Run JSON-defined pipelines from the palette. Type /wf to list, /wf <id> to fire.',
  version: '1.0.0',
  intents: [
    {
      id: 'run',
      prefix: '/wf',
      label: 'Run workflow',
      description: 'Fire a workflow manually. Use /wf to list them.',
      placeholder: 'workflow-id',
      handler: (input, ctx) => {
        const trimmed = input.trim();
        const list = ctx.listWorkflows();
        if (!trimmed) {
          if (list.length === 0) {
            return 'No workflows yet. Drop a JSON file under ~/.jarvis/workflows/.';
          }
          const lines = list.map((w) => {
            const tag =
              w.trigger.kind === 'cron'
                ? `cron · ${w.trigger.every}`
                : `manual${w.trigger.palette ? ' · /' + w.trigger.palette : ''}`;
            const off = w.enabled ? '' : ' · disabled';
            return `· ${w.id} — ${tag}${off}`;
          });
          return `Workflows:\n${lines.join('\n')}`;
        }
        const def = list.find((w) => w.id === trimmed);
        if (!def) {
          return `Workflow not found: ${trimmed}. Type /wf with no args to list them.`;
        }
        try {
          const run = ctx.runWorkflow(def.id);
          ctx.logActivity({
            kind: 'workflow.run',
            label: `Workflow fired (palette) · ${def.name}`,
            detail: { workflowId: def.id, runId: run.id, trigger: 'manual' },
          });
          return `Running · ${def.name}`;
        } catch (err) {
          return `Run failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ],
};
