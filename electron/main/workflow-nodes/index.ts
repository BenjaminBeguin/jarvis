import type { NodeHandler } from './types.js';

import { batchPromptOutputNode } from './batch-prompt-output.js';
import { draftOutputNode } from './draft-output.js';
import { draftStoreWriteNode } from './draft-store-write.js';
import { httpFetchNode } from './http-fetch.js';
import { inboxWriteNode } from './inbox-write.js';
import { mcpCallNode } from './mcp-call.js';
import { notifyNode } from './notify.js';
import { osascriptNode } from './osascript.js';
import { promptOutputNode } from './prompt-output.js';
import { runSkillNode } from './run-skill.js';
import { shellNode } from './shell.js';
import { transformNode } from './transform.js';

/**
 * Registry of every workflow node type the compiler knows about.
 * Adding a node: write its handler under workflow-nodes/, then add
 * an entry here. The compiler looks up `params.type` against this
 * map to wire each pipeline step's `invoke.src`.
 */
// Each handler is a fromPromise actor with its own narrow params
// type. We cast through unknown because the registry value is "any
// node handler" — the params shape only matters inside the handler
// itself, which validates its own keys at runtime.
export const NODE_REGISTRY: Record<string, NodeHandler> = {
  'http-fetch': httpFetchNode as unknown as NodeHandler,
  osascript: osascriptNode as unknown as NodeHandler,
  shell: shellNode as unknown as NodeHandler,
  transform: transformNode as unknown as NodeHandler,
  'inbox-write': inboxWriteNode as unknown as NodeHandler,
  notify: notifyNode as unknown as NodeHandler,
  'run-skill': runSkillNode as unknown as NodeHandler,
  'mcp-call': mcpCallNode as unknown as NodeHandler,
  'draft-output': draftOutputNode as unknown as NodeHandler,
  'draft-store-write': draftStoreWriteNode as unknown as NodeHandler,
  'prompt-output': promptOutputNode as unknown as NodeHandler,
  'batch-prompt-output': batchPromptOutputNode as unknown as NodeHandler,
};

export type { NodeHandler, NodeHandlerInput, WorkflowNodeContext } from './types.js';
