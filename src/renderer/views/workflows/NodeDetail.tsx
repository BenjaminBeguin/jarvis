import Prism from 'prismjs';
import 'prismjs/components/prism-applescript';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';

import type { WorkflowNodeDef } from '../../../shared/types';

/**
 * Renders a node's params in a type-aware way. Each node type gets a
 * compact summary card showing the fields the user actually cares
 * about — URL+method+auth for http-fetch, the JS fn for transform,
 * the script for osascript, etc.
 *
 * For unknown node types or unexpected params shapes, falls back to
 * pretty-printed JSON.
 */

type SyntaxLanguage = 'applescript' | 'javascript' | 'bash' | 'json' | 'plain';

interface Props {
  node: WorkflowNodeDef;
}

export function NodeDetail({ node }: Props) {
  const p = (node.params ?? {}) as Record<string, unknown>;
  switch (node.type) {
    case 'http-fetch':
      return <HttpFetchDetail p={p} />;
    case 'osascript':
      return <OsascriptDetail p={p} />;
    case 'shell':
      return <ShellDetail p={p} />;
    case 'transform':
      return <TransformDetail p={p} />;
    case 'inbox-write':
      return <InboxWriteDetail p={p} />;
    case 'notify':
      return <NotifyDetail p={p} />;
    case 'run-skill':
      return <RunSkillDetail p={p} />;
    case 'mcp-call':
      return <McpCallDetail p={p} />;
    case 'draft-output':
      return <DraftOutputDetail p={p} />;
    case 'prompt-output':
      return <PromptOutputDetail p={p} />;
    default:
      return <GenericDetail p={p} />;
  }
}

function DraftOutputDetail({ p }: { p: Record<string, unknown> }) {
  const source =
    typeof p['source'] === 'string' ? (p['source'] as string) : 'autopilot-drafts';
  return (
    <div className="wf-detail">
      <Field
        label="Title"
        value={typeof p['title'] === 'string' ? (p['title'] as string) : '?'}
      />
      {typeof p['subtitle'] === 'string' && (
        <Field label="Subtitle" value={p['subtitle'] as string} />
      )}
      <Field label="Source" value={<code>{source}</code>} mono />
      <div className="wf-detail__hint">
        Silent autopilot terminal. Lands as an Inbox row under{' '}
        <code>{source}</code> for later review. The previous step's full
        output goes into <code>InboxItem.body</code>.{' '}
        <code>{'{prev}'}</code> and <code>{'{prev.field}'}</code> substitute
        in <code>title</code> / <code>subtitle</code>.
      </div>
    </div>
  );
}

function PromptOutputDetail({ p }: { p: Record<string, unknown> }) {
  const onAccept =
    typeof p['onAccept'] === 'string' ? (p['onAccept'] as string) : 'prev';
  return (
    <div className="wf-detail">
      <Field
        label="Title"
        value={typeof p['title'] === 'string' ? (p['title'] as string) : '?'}
      />
      {typeof p['summary'] === 'string' && (
        <Field label="Summary" value={p['summary'] as string} />
      )}
      {typeof p['body'] === 'string' && (
        <Field label="Body override" value={p['body'] as string} />
      )}
      <Field label="On accept" value={<code>{onAccept}</code>} mono />
      <div className="wf-detail__hint">
        Blocks the pipeline. Fires a notification + opens the approval
        HUD with the previous step's output. <strong>Accept</strong> →
        pipeline continues; <strong>Reject + note</strong> appends to{' '}
        <code>~/.jarvis/autopilot/feedback/&lt;id&gt;.md</code> so the
        agent improves next run.{' '}
        {onAccept === 'feedback'
          ? 'Edited body becomes the next step\'s input.'
          : 'Pipeline continues with the original prev (edits are kept as positive feedback only).'}
      </div>
    </div>
  );
}

function McpCallDetail({ p }: { p: Record<string, unknown> }) {
  const mcp = typeof p['mcp'] === 'string' ? (p['mcp'] as string) : '';
  const tool = typeof p['tool'] === 'string' ? (p['tool'] as string) : '';
  const parse = typeof p['parse'] === 'string' ? (p['parse'] as string) : 'text';
  const args = p['args'];
  return (
    <>
      <Field label="MCP" value={mcp} mono />
      <Field label="Tool" value={tool} mono />
      <Field label="Parse" value={parse} />
      {args !== undefined && (
        <Field
          label="Args"
          value={
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(args, null, 2)}
            </pre>
          }
          mono
        />
      )}
    </>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="wf-field">
      <span className="wf-field__label">{label}</span>
      <span className={`wf-field__value${mono ? ' wf-field__value--mono' : ''}`}>
        {value}
      </span>
    </div>
  );
}

/**
 * Syntax-highlighted code block with a line-number gutter. The whole
 * block is highlighted in one pass (so multi-line tokens like template
 * literals or block comments stay tokenized correctly); line numbers
 * are a separate read-only column that scrolls with the code.
 *
 * `language='plain'` (or an unknown grammar) skips highlighting and
 * just renders the raw text — same shell, no spans.
 */
function SyntaxCode({
  code,
  language,
}: {
  code: string;
  language: SyntaxLanguage;
}) {
  const grammar = language !== 'plain' ? Prism.languages[language] : null;
  const html = grammar
    ? Prism.highlight(code, grammar, language)
    : escapeHtml(code);
  const lineCount = code.split('\n').length;
  const gutter = Array.from({ length: lineCount }, (_, i) => String(i + 1)).join(
    '\n',
  );
  return (
    <pre className={`wf-detail__code wf-detail__code--${language}`}>
      <span className="wf-detail__code-gutter" aria-hidden="true">
        {gutter}
      </span>
      <code
        className={`wf-detail__code-body language-${language}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </pre>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function HttpFetchDetail({ p }: { p: Record<string, unknown> }) {
  const method = typeof p.method === 'string' ? p.method : 'GET';
  const url = typeof p.url === 'string' ? p.url : '';
  const auth = p.auth as
    | { mcp?: string; var?: string; scheme?: string }
    | undefined;
  const bodyEncoding =
    typeof p.bodyEncoding === 'string' ? p.bodyEncoding : 'json';
  const headers = p.headers as Record<string, string> | undefined;

  return (
    <div className="wf-detail">
      <Field
        label="Request"
        value={
          <span>
            <span className="wf-detail__method">{method}</span>{' '}
            <span className="wf-detail__url">{url}</span>
          </span>
        }
      />
      {auth && (
        <Field
          label="Auth"
          value={
            <span>
              <code>{auth.var ?? '?'}</code> from <code>mcp.{auth.mcp ?? '?'}</code>
              {auth.scheme ? ` · ${auth.scheme}` : ''}
            </span>
          }
        />
      )}
      {headers && Object.keys(headers).length > 0 && (
        <Field
          label="Headers"
          value={
            <code>
              {Object.entries(headers)
                .map(([k, v]) => `${k}: ${v}`)
                .join('  ·  ')}
            </code>
          }
          mono
        />
      )}
      {p.body !== undefined && (
        <>
          <Field label="Body encoding" value={<code>{bodyEncoding}</code>} />
          <div className="wf-detail__heading">Body</div>
          <SyntaxCode
            code={asString(p.body)}
            language={bodyEncoding === 'json' ? 'json' : 'plain'}
          />
        </>
      )}
    </div>
  );
}

function OsascriptDetail({ p }: { p: Record<string, unknown> }) {
  const script = typeof p.script === 'string' ? p.script : '';
  return (
    <div className="wf-detail">
      <Field
        label="Timeout"
        value={
          typeof p.timeoutMs === 'number' ? `${p.timeoutMs}ms` : '10000ms'
        }
      />
      <div className="wf-detail__heading">AppleScript</div>
      <SyntaxCode code={script.replace(/^\n+/, '')} language="applescript" />
    </div>
  );
}

function ShellDetail({ p }: { p: Record<string, unknown> }) {
  const cmd = typeof p.cmd === 'string' ? p.cmd : '';
  const args = Array.isArray(p.args) ? (p.args as unknown[]).join(' ') : '';
  return (
    <div className="wf-detail">
      <Field label="Command" value={<code>{cmd}</code>} mono />
      {args && <Field label="Args" value={<code>{args}</code>} mono />}
      {typeof p.cwd === 'string' && (
        <Field label="Cwd" value={<code>{p.cwd}</code>} mono />
      )}
      {typeof p.timeoutMs === 'number' && (
        <Field label="Timeout" value={`${p.timeoutMs}ms`} />
      )}
      {cmd && (
        <>
          <div className="wf-detail__heading">Invocation</div>
          <SyntaxCode code={[cmd, args].filter(Boolean).join(' ')} language="bash" />
        </>
      )}
    </div>
  );
}

function TransformDetail({ p }: { p: Record<string, unknown> }) {
  const fn = typeof p.fn === 'string' ? p.fn : '';
  return (
    <div className="wf-detail">
      <Field
        label="Sandbox"
        value="new Function('$', `return (…)`) — no globals, no imports"
      />
      <div className="wf-detail__heading">Function body</div>
      <SyntaxCode code={fn} language="javascript" />
    </div>
  );
}

function InboxWriteDetail({ p }: { p: Record<string, unknown> }) {
  return (
    <div className="wf-detail">
      <Field
        label="Source"
        value={<code>{typeof p.source === 'string' ? p.source : '?'}</code>}
        mono
      />
      <Field
        label="Label"
        value={typeof p.label === 'string' ? p.label : '?'}
      />
      <div className="wf-detail__hint">
        Expects an array of <code>InboxItem</code> from the previous step.
        Items missing <code>id</code> / <code>title</code> /{' '}
        <code>createdAt</code> are dropped silently.
      </div>
    </div>
  );
}

function NotifyDetail({ p }: { p: Record<string, unknown> }) {
  return (
    <div className="wf-detail">
      <Field
        label="Title"
        value={typeof p.title === 'string' ? p.title : ''}
      />
      {typeof p.body === 'string' && (
        <Field label="Body" value={p.body} />
      )}
      {typeof p.source === 'string' && (
        <Field label="Source" value={<code>{p.source}</code>} mono />
      )}
    </div>
  );
}

function RunSkillDetail({ p }: { p: Record<string, unknown> }) {
  return (
    <div className="wf-detail">
      <Field
        label="Skill"
        value={<code>{typeof p.skillId === 'string' ? p.skillId : '?'}</code>}
        mono
      />
      {typeof p.prompt === 'string' && (
        <>
          <div className="wf-detail__heading">Prompt</div>
          <SyntaxCode code={p.prompt} language="plain" />
        </>
      )}
    </div>
  );
}

function GenericDetail({ p }: { p: Record<string, unknown> }) {
  return (
    <div className="wf-detail">
      <div className="wf-detail__heading">Params</div>
      <SyntaxCode code={asString(p)} language="json" />
    </div>
  );
}
