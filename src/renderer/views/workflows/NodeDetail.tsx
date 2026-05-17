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
    default:
      return <GenericDetail p={p} />;
  }
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

function CodeBlock({ children }: { children: string }) {
  return <pre className="wf-detail__code">{children}</pre>;
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
          <CodeBlock>{asString(p.body)}</CodeBlock>
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
      <CodeBlock>{script}</CodeBlock>
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
      <CodeBlock>{fn}</CodeBlock>
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
          <CodeBlock>{p.prompt}</CodeBlock>
        </>
      )}
    </div>
  );
}

function GenericDetail({ p }: { p: Record<string, unknown> }) {
  return (
    <div className="wf-detail">
      <div className="wf-detail__heading">Params</div>
      <CodeBlock>{asString(p)}</CodeBlock>
    </div>
  );
}
