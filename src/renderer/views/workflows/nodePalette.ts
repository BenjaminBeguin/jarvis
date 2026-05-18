import type { WorkflowNodeDef } from '../../../shared/types';

/**
 * Renderer-side catalog of every workflow node type the agent can
 * add via the "+ Add node" button. Each entry pairs a short label
 * with a `template()` function that returns a fresh stub node — the
 * UI appends the stub to the selected workflow's pipeline, saves,
 * and pops the JSON dock open with the new node highlighted so the
 * user can finish wiring it (URLs, args, etc.).
 *
 * Adding a node type: write its handler under
 * electron/main/workflow-nodes/, register it in
 * electron/main/workflow-nodes/index.ts + WorkflowNodeType in
 * src/shared/types.ts, then add a row below with a sensible stub.
 */
export interface NodeTemplate {
  type: WorkflowNodeDef['type'];
  /** Short title used in the palette dropdown. */
  label: string;
  /** One-line "what this does", shown under the label. */
  description: string;
  /** Optional grouping for the dropdown (Provider / Logic / I/O). */
  group: 'Fetch' | 'Logic' | 'Action' | 'I/O';
  /** Stub the user can edit. Should validate as a real node — the
   *  workflow can run immediately even before customization. */
  template(): WorkflowNodeDef;
}

export const NODE_TEMPLATES: NodeTemplate[] = [
  {
    type: 'http-fetch',
    label: 'HTTP Fetch',
    description:
      'GET/POST/etc. against any URL. Inject auth from an mcp.json entry; validate response with a JS expression.',
    group: 'Fetch',
    template: () => ({
      type: 'http-fetch',
      params: {
        url: 'https://api.example.com/endpoint',
        method: 'GET',
        responseType: 'json',
      },
    }),
  },
  {
    type: 'mcp-call',
    label: 'MCP Tool Call',
    description:
      'Invoke a tool on any MCP server (stdio in mcp.json, OAuth integrations like calendar / gmail / slack / notion / linear, GitHub). Output is the tool result.',
    group: 'Fetch',
    template: () => ({
      type: 'mcp-call',
      params: {
        mcp: 'github',
        tool: 'list_issues',
        args: {},
        parse: 'text',
      },
    }),
  },
  {
    type: 'transform',
    label: 'Transform',
    description:
      'Run a JS expression on the previous step\'s output ($ = prev). Filter, map, reshape — return the new value.',
    group: 'Logic',
    template: () => ({
      type: 'transform',
      params: {
        // Sensible default: pass-through. Most users overwrite this.
        fn: '$',
      },
    }),
  },
  {
    type: 'inbox-write',
    label: 'Inbox Write',
    description:
      'Write a typed list of InboxItems to an inbox source (slack-pulse.json, calendar.json, etc.). Picks up in the Inbox tab + Dashboard.',
    group: 'I/O',
    template: () => ({
      type: 'inbox-write',
      params: {
        source: 'my-source',
      },
    }),
  },
  {
    type: 'notify',
    label: 'Notify',
    description: 'macOS notification with title + body. Routed through the notifier so other surfaces (Telegram bot, etc.) also see it.',
    group: 'I/O',
    template: () => ({
      type: 'notify',
      params: {
        title: 'Workflow finished',
        body: 'Tap to open',
        source: 'workflow',
      },
    }),
  },
  {
    type: 'osascript',
    label: 'AppleScript',
    description:
      'Run a macOS AppleScript. Useful for Calendar.app, Notes, Reminders, system controls. Returns stdout.',
    group: 'Action',
    template: () => ({
      type: 'osascript',
      params: {
        script: 'tell application "System Events" to get name of first process',
        timeoutMs: 5000,
      },
    }),
  },
  {
    type: 'shell',
    label: 'Shell',
    description:
      'Run a binary with args (gh, git, jq, etc.). Returns stdout. Use http-fetch if you only need to call an HTTP API.',
    group: 'Action',
    template: () => ({
      type: 'shell',
      params: {
        command: 'gh',
        args: ['pr', 'list', '--state', 'open', '--limit', '10'],
      },
    }),
  },
  {
    type: 'run-skill',
    label: 'Run Skill',
    description:
      'Hand off the previous step\'s output to a Claude skill. Useful for natural-language summarization / triage / drafting.',
    group: 'Action',
    template: () => ({
      type: 'run-skill',
      params: {
        skillId: 'daily-brief',
        prompt: 'Summarize the data above into 3 bullets.',
      },
    }),
  },
];

/**
 * Generate a fresh empty workflow stub. Used by the "+ New workflow"
 * button so a user can start from scratch in the renderer instead of
 * dropping a JSON file under ~/.jarvis/workflows/ by hand.
 */
export function emptyWorkflow(id: string, name: string): {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: { kind: 'manual' };
  pipeline: WorkflowNodeDef[];
} {
  return {
    id,
    name,
    description: '',
    enabled: false,
    trigger: { kind: 'manual' },
    pipeline: [],
  };
}
