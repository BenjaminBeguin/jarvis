import { type ReactNode, useEffect, useState } from 'react';

import type { AppStatus } from '@shared/types';

import { toast } from './Toaster';

/**
 * The Builder panel — a guided "what do you want to build?" surface for
 * the user. Three layers:
 *
 *   1. Setup health check at the top — derives green/red dots from
 *      `status` so the user can see at a glance whether auth is ready.
 *   2. Category cards — Skill, Module, Routine, MCP, Inbox source. Each
 *      unfolds a checklist of concrete steps with file paths + snippets.
 *      Step-done state lives in localStorage so closing/reopening the
 *      panel doesn't reset progress.
 *   3. Free-text prompt — launches a Task with a "builder-helper" lead
 *      prompt so Claude can walk the user through anything not covered
 *      by a static guide.
 */

type Category = 'skill' | 'module' | 'routine' | 'mcp' | 'inbox-source';

interface CategoryDef {
  id: Category;
  title: string;
  subtitle: string;
  intro: string;
  steps: Step[];
}

interface Step {
  id: string;
  title: string;
  body: ReactNode;
  code?: string;
  codeLang?: 'ts' | 'md' | 'json' | 'sh';
  filePath?: string;
}

const CATEGORIES: CategoryDef[] = [
  {
    id: 'skill',
    title: 'A new skill',
    subtitle: 'A SKILL.md file: saved Task template Claude loads on demand',
    intro:
      'Skills are the easiest extension surface. A skill is a markdown file with frontmatter (name, description, allowed-tools, mcp-servers) and a body that becomes the system prompt. Drop the file under ~/.jarvis/skills/<name>/SKILL.md and it shows up in the palette + Skills tab — no rebuild.',
    steps: [
      {
        id: 'purpose',
        title: 'Decide what the skill does',
        body: (
          <>
            One sentence: <em>"This skill takes [input] and produces [output]."</em>{' '}
            Examples: "Draft a Slack reply to a thread URL", "Summarize the
            last week of meetings as a markdown digest", "Find PRs assigned to
            me and rank by staleness". If you can&apos;t state it in one
            sentence, split into two skills.
          </>
        ),
      },
      {
        id: 'tools',
        title: 'Pick allowed-tools + mcp-servers',
        body: (
          <>
            <code>allowed-tools</code> is a whitelist of every tool the agent
            can call: built-ins like <code>Read</code>, <code>Write</code>,{' '}
            <code>Bash</code>, plus MCP tools like{' '}
            <code>mcp__slack__*</code>. <code>mcp-servers</code> opts in to
            stdio MCPs declared in <code>~/.jarvis/mcp.json</code>. Use{' '}
            <code>mcp-servers: [&quot;*&quot;]</code> to inherit every
            configured server (useful for omnibus skills like{' '}
            <code>/send</code>).
          </>
        ),
      },
      {
        id: 'write',
        title: 'Write the SKILL.md',
        body: (
          <>
            Frontmatter first, then the system prompt. Be concrete and
            instruction-heavy — Claude follows the body literally. Include
            input/output shape, any JSON files to read/write, examples of
            success and failure, and what counts as &quot;done.&quot;
          </>
        ),
        filePath: '~/.jarvis/skills/<name>/SKILL.md',
        codeLang: 'md',
        code: `---
name: my-skill
description: One-line pitch that decides when the agent picks this skill.
allowed-tools:
  - Read
  - Bash
  - mcp__jarvis__notify
  - mcp__jarvis__log_activity
mcp-servers: []
---

You are a focused assistant that does <X>.

## Inputs
The user gives you <Y>. If <Y> is missing, ask once.

## Steps
1. Do this.
2. Then that.
3. Report back with <Z>.
`,
      },
      {
        id: 'test',
        title: 'Test from the palette',
        body: (
          <>
            ⌘⇧J → start typing the skill name, pick it from the picker, supply
            an input, Enter. Watch the streamed transcript in the
            Observatory. If the agent goes off the rails, edit the body —
            chokidar reloads the skill on save, no restart.
          </>
        ),
      },
      {
        id: 'iterate',
        title: 'Tighten the prompt',
        body: (
          <>
            First-draft skills are usually too vague. Run it 3-5 times on real
            inputs, note where it asks unnecessary questions or skips steps,
            and rewrite the body to constrain. The <code>preferences.md</code>{' '}
            overlay (Settings → Preferences) is prepended to every task and
            is the right place for cross-skill conventions.
          </>
        ),
      },
    ],
  },
  {
    id: 'module',
    title: 'A new module',
    subtitle: 'TypeScript code that registers palette intents, pages, settings',
    intro:
      'Modules are heavier than skills — they\'re code, not markdown — but they can do things skills can\'t: register a palette intent with a custom handler (no Claude turn), open a renderer page, declare schema-driven settings. Every existing /note, /send, /meeting is a module. Loaded once on app start.',
    steps: [
      {
        id: 'shape',
        title: 'Pick the surface(s) it provides',
        body: (
          <>
            A module can register any combination of:
            <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
              <li>
                <strong>Intents</strong> — <code>/prefix</code> handlers
                triggered from the palette.
              </li>
              <li>
                <strong>Pages</strong> — renderer routes accessible from
                Settings → Modules.
              </li>
              <li>
                <strong>Settings</strong> — schema-driven user prefs that
                appear in Settings → Modules automatically.
              </li>
            </ul>
            See <code>electron/main/modules/types.ts</code> for the full{' '}
            <code>Module</code> shape and{' '}
            <code>electron/main/modules/quick-note.ts</code> for a worked
            example with all three.
          </>
        ),
      },
      {
        id: 'scaffold',
        title: 'Write the module file',
        body: (
          <>
            Create <code>electron/main/modules/&lt;id&gt;.ts</code> with a
            named export. Keep state on disk under{' '}
            <code>~/.jarvis/&lt;id&gt;/</code> via{' '}
            <code>ctx.jarvisRoot</code>. Never import from{' '}
            <code>electron/main/</code> directly — go through{' '}
            <code>ModuleContext</code>. If you need a capability not on the
            context, add it to <code>setContext()</code> in{' '}
            <code>index.ts</code>.
          </>
        ),
        filePath: 'electron/main/modules/<id>.ts',
        codeLang: 'ts',
        code: `import type { Module } from './types.js';

export const myModule: Module = {
  id: 'my-module',
  name: 'My module',
  description: 'What it does, one short sentence.',
  version: '1.0.0',
  intents: [
    {
      id: 'do-thing',
      prefix: '/dothing',
      label: 'Do the thing',
      placeholder: 'optional argument',
      handler: async (input, ctx) => {
        // Side-effect on disk + notify, or launch a Task via
        // ctx.launchTask({ prompt, skillId, origin: 'api' }).
        ctx.notify('Did it', input);
        return 'Saved';
      },
    },
  ],
};`,
      },
      {
        id: 'register',
        title: 'Register in index.ts',
        body: (
          <>
            After <code>app.whenReady()</code> in{' '}
            <code>electron/main/index.ts</code>, import and register your
            module on the registry. The renderer learns about it via{' '}
            <code>onModulesChanged</code>; the palette picks up the intent
            automatically.
          </>
        ),
        codeLang: 'ts',
        code: `import { myModule } from './modules/my-module.js';

// ... after modules.setContext({...})
await modules.register(myModule);`,
      },
      {
        id: 'settings',
        title: 'Add settings (optional)',
        body: (
          <>
            Declare a <code>settings</code> field on the module export and
            the values appear in Settings → Modules with native renderer
            controls (boolean, number, text, select). Values persist in{' '}
            <code>config.json</code>. Read them in main with{' '}
            <code>modules.readSettings(id)</code>.
          </>
        ),
        codeLang: 'ts',
        code: `settings: {
  description: 'Tune how the module behaves.',
  fields: [
    {
      key: 'cadence',
      label: 'Run cadence',
      hint: 'How often the background watcher polls.',
      type: 'select',
      default: 'hourly',
      options: [
        { value: 'off', label: 'Off' },
        { value: 'hourly', label: 'Hourly' },
        { value: 'daily', label: 'Daily' },
      ],
    },
  ],
},`,
      },
      {
        id: 'rebuild',
        title: 'Restart pnpm dev',
        body: (
          <>
            Modules are bundled at build time — unlike skills, hot reload
            doesn&apos;t pick them up. Stop <code>pnpm dev</code>, run{' '}
            <code>pnpm typecheck</code>, then restart. The new intent is
            in the palette.
          </>
        ),
      },
    ],
  },
  {
    id: 'routine',
    title: 'A new routine',
    subtitle: 'Cron-driven skill fire — daily summary, hourly pulse, etc',
    intro:
      'A routine is a (skillId, cron, input) tuple. node-cron fires it on schedule; the Observatory shows each run with cost + output. Briefings, the auto-dedupe pass, and the slack-pulse pattern are all routines under the hood.',
    steps: [
      {
        id: 'skill',
        title: 'Make sure the skill exists',
        body: (
          <>
            A routine needs a skill to fire. Either use a built-in (see
            Skills tab) or build a new one (back to the Skill guide). The
            skill body should be self-contained — routines fire while
            you&apos;re not watching, so there&apos;s nowhere to ask
            clarifying questions.
          </>
        ),
      },
      {
        id: 'cron',
        title: 'Pick the cron expression',
        body: (
          <>
            5 fields: <code>minute hour dom month dow</code>. Common shapes:
            <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
              <li>
                <code>0 9 * * *</code> — every day at 09:00
              </li>
              <li>
                <code>0 9 * * 1-5</code> — weekdays at 09:00
              </li>
              <li>
                <code>*/10 * * * *</code> — every 10 minutes
              </li>
              <li>
                <code>0 18 * * 5</code> — Friday 18:00 (weekly retro)
              </li>
            </ul>
          </>
        ),
      },
      {
        id: 'create',
        title: 'Add it in the Routines tab',
        body: (
          <>
            Routines tab → &quot;+ New routine&quot;. Pick the skill, paste
            the cron, write the input prompt (optional — falls back to the
            skill body), toggle Enabled. Saved into{' '}
            <code>~/.jarvis/routines.json</code>. Editing the JSON directly
            also works; chokidar reloads.
          </>
        ),
        filePath: '~/.jarvis/routines.json',
        codeLang: 'json',
        code: `[
  {
    "id": "daily-recap",
    "skillId": "daily-recap",
    "cron": "0 18 * * *",
    "input": "Summarize today's work.",
    "enabled": true,
    "showInCalendar": true
  }
]`,
      },
      {
        id: 'verify',
        title: 'Verify the next-fire',
        body: (
          <>
            The Routines tab shows the next-fire time per routine. If it says
            &quot;never&quot;, the cron is invalid — re-check with{' '}
            <a
              href="https://crontab.guru"
              onClick={(e) => {
                e.preventDefault();
                void window.jarvis.openExternal('https://crontab.guru');
              }}
            >
              crontab.guru
            </a>
            . You can also trigger a manual fire from the routine row
            (Run now) to confirm the skill behaves as expected before
            relying on the schedule.
          </>
        ),
      },
    ],
  },
  {
    id: 'mcp',
    title: 'A new MCP integration',
    subtitle: 'External tool — Slack, Gmail, Linear, Notion, GitHub, custom',
    intro:
      'MCP servers are how Jarvis talks to external systems. Stdio MCPs (subprocess on launch) propagate to every task; Claude.ai-hosted MCPs do NOT propagate to the Agent SDK and won\'t work in Jarvis. Catalog options in Settings → Integrations or paste a server directly in ~/.jarvis/mcp.json.',
    steps: [
      {
        id: 'pick',
        title: 'Find the MCP server',
        body: (
          <>
            Settings → Integrations has a built-in catalog with one-click
            install for the common ones (Slack, Gmail, Linear, GitHub,
            Notion). For anything custom: the server is an npm package or
            HTTP endpoint that speaks the Model Context Protocol. See{' '}
            <a
              href="https://modelcontextprotocol.io"
              onClick={(e) => {
                e.preventDefault();
                void window.jarvis.openExternal(
                  'https://modelcontextprotocol.io',
                );
              }}
            >
              modelcontextprotocol.io
            </a>
            .
          </>
        ),
      },
      {
        id: 'add',
        title: 'Add it to mcp.json',
        body: (
          <>
            Either via Settings → Integrations (form-driven), or edit{' '}
            <code>~/.jarvis/mcp.json</code> directly. The file is watched
            with chokidar — no restart needed.
          </>
        ),
        filePath: '~/.jarvis/mcp.json',
        codeLang: 'json',
        code: `{
  "mcpServers": {
    "my-service": {
      "command": "npx",
      "args": ["-y", "@vendor/mcp-server"],
      "env": {
        "MY_API_KEY": "..."
      }
    }
  }
}`,
      },
      {
        id: 'verify',
        title: 'Verify it loaded',
        body: (
          <>
            Settings → Integrations lists every server with its tool count
            once it boots. Click into a row to see the tools it exposes. If
            the row shows a red status, check the server&apos;s stderr in
            the Observatory; common failures are missing env vars or auth.
          </>
        ),
      },
      {
        id: 'opt-in',
        title: 'Opt skills into the MCP',
        body: (
          <>
            MCPs don&apos;t auto-attach to skills — each skill explicitly
            lists which ones it wants. Edit the skill&apos;s frontmatter:
          </>
        ),
        codeLang: 'md',
        code: `---
name: linear-recap
mcp-servers: [linear]
allowed-tools: [mcp__linear__*]
---`,
      },
    ],
  },
  {
    id: 'inbox-source',
    title: 'A new inbox source',
    subtitle: 'Recurring "things waiting on you" feed in the Inbox tab',
    intro:
      'Inbox sources surface time-sensitive or attention-worthy items in one place. The pattern is a skill + a routine: the skill writes ~/.jarvis/inbox/<source>.json on a schedule, and Jarvis picks it up automatically. No code needed.',
    steps: [
      {
        id: 'decide',
        title: 'Decide what waits on you',
        body: (
          <>
            Good inbox candidates: PRs assigned to you, Linear issues
            blocking your sprint, Gmail threads awaiting reply, Notion
            comments left over the weekend, GitHub Actions failures on
            your branches, calendar events in the next 4 hours. Each item
            needs an action — &quot;news of the world&quot; doesn&apos;t
            belong in the Inbox.
          </>
        ),
      },
      {
        id: 'skill',
        title: 'Build the skill that writes the JSON',
        body: (
          <>
            The skill scans the source (via an MCP usually) and writes a
            wrapped JSON array to <code>~/.jarvis/inbox/&lt;source&gt;.json</code>.
            Stable <code>id</code> per item — same id across runs means
            &quot;same thing,&quot; not a re-ping. See{' '}
            <code>docs/scenarios.md</code> for the format reference.
          </>
        ),
        filePath: '~/.jarvis/inbox/<source>.json',
        codeLang: 'json',
        code: `{
  "source": "my-source",
  "label": "My source",
  "items": [
    {
      "id": "stable-id-per-item",
      "title": "What's waiting",
      "subtitle": "optional context",
      "createdAt": 1715700000000,
      "url": "https://...",
      "action": {
        "label": "Address",
        "skillId": "address-thing",
        "prompt": "Address: https://..."
      }
    }
  ]
}`,
      },
      {
        id: 'routine',
        title: 'Schedule the skill via a routine',
        body: (
          <>
            How often does the source change? Pick the cron. 10 min is fine
            for chat (Slack pulses), 1 hour for issue trackers, every 6
            hours for &quot;leftover items&quot; that decay slowly. Add via
            Routines tab.
          </>
        ),
      },
      {
        id: 'watch',
        title: 'Wait for the Inbox to refresh',
        body: (
          <>
            The Inbox auto-refreshes every 5 minutes. The first run of your
            routine + the next auto-refresh = items appear. Dismissed
            items stay dismissed (see ~/.jarvis/inbox/.dismissed.json) so
            repeated pings don&apos;t spam you.
          </>
        ),
      },
    ],
  },
];

interface HealthCheck {
  label: string;
  ok: boolean;
  detail: string;
}

function deriveHealth(status: AppStatus): HealthCheck[] {
  const out: HealthCheck[] = [];
  out.push({
    label: 'Auth mode chosen',
    ok: !!status.authMode,
    detail: status.authMode
      ? `Mode: ${status.authMode}`
      : 'Pick subscription or API key in General first.',
  });
  if (status.authMode === 'subscription') {
    out.push({
      label: 'Claude CLI detected',
      ok: !!status.claudeBinaryPath,
      detail: status.claudeBinaryPath
        ? `at ${status.claudeBinaryPath}`
        : 'Run `claude login` in a terminal, or switch to API-key mode.',
    });
  }
  if (status.authMode === 'api-key') {
    out.push({
      label: 'API key in Keychain',
      ok: status.hasApiKey,
      detail: status.hasApiKey
        ? 'Stored in macOS Keychain via keytar.'
        : 'Add it in General. No env vars needed.',
    });
  }
  return out;
}

export function BuilderPanel({ status }: { status: AppStatus }) {
  const [category, setCategory] = useState<Category | null>(null);
  const [prompt, setPrompt] = useState('');
  const [launching, setLaunching] = useState(false);
  const health = deriveHealth(status);
  const ready = health.every((h) => h.ok);

  const ask = async () => {
    const body = prompt.trim();
    if (!body) return;
    setLaunching(true);
    try {
      // Prefix the prompt with a builder framing so Claude knows to act
      // as a code-aware scaffolder for this repo specifically. CLAUDE.md
      // loads automatically with every task, so no need to inline it.
      const framed = [
        'You are helping the user extend Jarvis. The codebase conventions are in CLAUDE.md (already loaded into your context).',
        '',
        'Walk through the steps interactively:',
        '1. Clarify what they want to build (skill, module, routine, MCP, or inbox source — or something else).',
        '2. If a category fits, follow that category\'s file layout from CLAUDE.md / docs/scenarios.md.',
        '3. Propose the file(s) and ask before writing.',
        '4. Stop and check in after each major file so the user can correct course.',
        '',
        'User request:',
        '',
        body,
      ].join('\n');
      const summary = await window.jarvis.launchTask({
        prompt: framed,
        origin: 'palette',
      });
      void window.jarvis.showAnswerHud(summary.id);
      setPrompt('');
      toast({ message: 'Builder helper launched — answer HUD is tracking it.' });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="builder">
      <header className="builder__header">
        <h3>BUILD SOMETHING</h3>
        <p className="settings__hint">
          A guided walkthrough for adding skills, modules, routines, MCP
          integrations, and custom inbox sources. Step state persists across
          sessions; the prompt at the bottom launches an agent that knows
          this codebase.
        </p>
      </header>

      <section className="builder__health">
        <h4 className="settings__subhead">SETUP CHECK</h4>
        <ul className="builder__health-list">
          {health.map((h) => (
            <li key={h.label} className={h.ok ? 'ok' : 'bad'}>
              <span className="builder__health-dot" />
              <div>
                <strong>{h.label}</strong>
                <span className="builder__health-detail">{h.detail}</span>
              </div>
            </li>
          ))}
        </ul>
        {!ready && (
          <p className="settings__hint settings__hint--dim">
            Tasks won&apos;t run until auth is green. Builder steps still
            work; you can read through and stage files first.
          </p>
        )}
      </section>

      <section className="builder__categories">
        <h4 className="settings__subhead">PICK A CATEGORY</h4>
        <div className="builder__grid">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={`builder__card${category === c.id ? ' builder__card--active' : ''}`}
              onClick={() => setCategory(category === c.id ? null : c.id)}
            >
              <strong>{c.title}</strong>
              <span>{c.subtitle}</span>
            </button>
          ))}
        </div>
      </section>

      {category && <CategoryGuide def={CATEGORIES.find((c) => c.id === category)!} />}

      <section className="builder__prompt">
        <h4 className="settings__subhead">OR DESCRIBE WHAT YOU WANT</h4>
        <p className="settings__hint">
          Don&apos;t fit a category, or want help filling in the blanks?
          Type the goal and the builder agent will read CLAUDE.md, ask
          follow-ups, and propose files before writing anything.
        </p>
        <textarea
          className="builder__textarea"
          rows={3}
          placeholder='e.g. "A daily routine that checks my open PRs and writes a one-line digest to the inbox"'
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={launching}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void ask();
            }
          }}
        />
        <div className="builder__prompt-actions">
          <span className="settings__hint settings__hint--dim">
            ⌘↵ to launch
          </span>
          <button
            className="settings__primary"
            onClick={ask}
            disabled={!prompt.trim() || launching || !ready}
            title={
              !ready
                ? 'Set up auth first.'
                : !prompt.trim()
                  ? 'Type a goal first.'
                  : 'Launch the builder agent.'
            }
          >
            {launching ? 'Launching…' : 'Ask Claude →'}
          </button>
        </div>
      </section>
    </div>
  );
}

function CategoryGuide({ def }: { def: CategoryDef }) {
  // Persist "step done" per (category, step) in localStorage so the user
  // can come back later and see which steps they checked off.
  const [done, setDone] = useState<Set<string>>(() => readDone(def.id));
  // Re-read whenever the category changes — different sets per def.id.
  useEffect(() => {
    setDone(readDone(def.id));
  }, [def.id]);

  const toggle = (stepId: string) => {
    const next = new Set(done);
    if (next.has(stepId)) next.delete(stepId);
    else next.add(stepId);
    setDone(next);
    writeDone(def.id, next);
  };

  const completed = def.steps.filter((s) => done.has(s.id)).length;

  return (
    <section className="builder__guide">
      <div className="builder__guide-head">
        <h4>{def.title}</h4>
        <span className="builder__guide-progress">
          {completed} / {def.steps.length}
        </span>
      </div>
      <p className="builder__guide-intro">{def.intro}</p>
      <ol className="builder__steps">
        {def.steps.map((step, i) => {
          const isDone = done.has(step.id);
          return (
            <li
              key={step.id}
              className={`builder__step${isDone ? ' builder__step--done' : ''}`}
            >
              <button
                className="builder__step-check"
                onClick={() => toggle(step.id)}
                aria-label={isDone ? 'Mark not done' : 'Mark done'}
                title={isDone ? 'Mark not done' : 'Mark done'}
              >
                {isDone ? '✓' : i + 1}
              </button>
              <div className="builder__step-body">
                <h5>{step.title}</h5>
                <div className="builder__step-text">{step.body}</div>
                {step.filePath && (
                  <div className="builder__step-path">
                    <code>{step.filePath}</code>
                  </div>
                )}
                {step.code && (
                  <CodeBlock code={step.code} lang={step.codeLang ?? 'ts'} />
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast({ kind: 'error', message: 'Clipboard copy failed' });
    }
  };
  return (
    <div className="builder__code">
      <div className="builder__code-head">
        <span>{lang}</span>
        <button onClick={copy}>{copied ? 'copied' : 'copy'}</button>
      </div>
      <pre>{code}</pre>
    </div>
  );
}

function readDone(cat: Category): Set<string> {
  try {
    const raw = localStorage.getItem(`jarvis:builder:done:${cat}`);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v) => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

function writeDone(cat: Category, set: Set<string>): void {
  try {
    localStorage.setItem(
      `jarvis:builder:done:${cat}`,
      JSON.stringify([...set]),
    );
  } catch {
    // localStorage can be full/blocked; non-fatal.
  }
}
