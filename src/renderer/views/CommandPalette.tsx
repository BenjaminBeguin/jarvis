import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  ModuleSummary,
  PaletteIntentSummary,
  PermissionMode,
  ProjectDef,
  SessionConfig,
  SkillSummary,
  TranscribeProgress,
} from '../../shared/types';
import { AudioCapture } from '../voice/AudioCapture';

const ACTIVE_PROJECT_KEY = 'jarvis.activeProject';
const SESSION_CONFIG_KEY = 'jarvis.palette.sessionConfig';

/** Static curated list of currently-shipping Claude models. The SDK exposes
 * supportedModels() only on a live Query, so we'd need a throwaway query to
 * populate this dynamically — not worth the cost. Update this list when a
 * new model ships; an empty model field falls back to the SDK / Claude
 * Code default. */
const MODEL_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  { value: '', label: 'default', hint: "use Claude Code's default" },
  { value: 'claude-opus-4-7', label: 'opus 4.7', hint: 'deepest reasoning' },
  { value: 'claude-sonnet-4-6', label: 'sonnet 4.6', hint: 'balanced' },
  { value: 'claude-haiku-4-5', label: 'haiku 4.5', hint: 'fast / cheap' },
];

const PERMISSION_MODE_OPTIONS: Array<{
  value: PermissionMode;
  label: string;
  hint: string;
}> = [
  { value: 'bypassPermissions', label: 'yolo', hint: 'no prompts (Jarvis default)' },
  { value: 'acceptEdits', label: 'auto-edit', hint: 'auto-accept file edits' },
  { value: 'default', label: 'ask', hint: 'ask before tool use' },
  { value: 'plan', label: 'plan', hint: 'plan only, no edits' },
];

function loadSessionConfig(): SessionConfig {
  try {
    const raw = window.localStorage.getItem(SESSION_CONFIG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SessionConfig;
    return parsed || {};
  } catch {
    return {};
  }
}

function saveSessionConfig(cfg: SessionConfig): void {
  try {
    window.localStorage.setItem(SESSION_CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    // ignore
  }
}

/** Folders the user has picked at least once via the +dirs chip. Persist
 * the full history so the dropdown can offer "pick from before" instead
 * of forcing a native file dialog on every launch. Newest first. */
const RECENT_DIRS_KEY = 'jarvis.palette.recentDirs';
const RECENT_DIRS_MAX = 12;

function loadRecentDirs(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_DIRS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? (parsed.filter((p) => typeof p === 'string') as string[])
      : [];
  } catch {
    return [];
  }
}

function saveRecentDirs(list: string[]): void {
  try {
    window.localStorage.setItem(
      RECENT_DIRS_KEY,
      JSON.stringify(list.slice(0, RECENT_DIRS_MAX)),
    );
  } catch {
    // ignore
  }
}

function addRecentDirs(picked: string[]): string[] {
  const cur = loadRecentDirs();
  // Dedup, with the newly-picked entries bumped to the front.
  const merged = [
    ...picked,
    ...cur.filter((p) => !picked.includes(p)),
  ].slice(0, RECENT_DIRS_MAX);
  saveRecentDirs(merged);
  return merged;
}

function readActiveProject(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_PROJECT_KEY) || null;
  } catch {
    return null;
  }
}

interface PendingIntent extends PaletteIntentSummary {}

const HISTORY_KEY = 'jarvis.palette.history';
const HISTORY_MAX = 50;

/**
 * Placeholder suggestions that rotate when the palette is idle. Teaches
 * the three high-value patterns (free question, schedule, intent) without
 * adding a tutorial overlay.
 */
const PLACEHOLDER_HINTS = [
  '/ to pick · ask anything',
  'remind me in 2h to ship the patch',
  'check my PR in 20min and ping Luca if no review',
  '/status · what is happening right now',
  '/next · best move for the next 30 minutes',
  '/note quick thought to look at later',
  'create a hivecore project',
  'show me today',
  'show inbox',
];

function loadHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function pushHistory(prompt: string): void {
  const trimmed = prompt.trim();
  if (!trimmed) return;
  try {
    const cur = loadHistory();
    // Drop duplicates so the most-recent is always at index 0.
    const next = [trimmed, ...cur.filter((p) => p !== trimmed)].slice(0, HISTORY_MAX);
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // Storage failures are non-fatal; the user just loses history.
  }
}

function formatScheduleHint(fireAt: number): string {
  const diff = fireAt - Date.now();
  if (diff <= 0) return 'now';
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'in <1m';
  if (m < 60) return `in ${m}m`;
  const h = m / 60;
  if (h < 24) {
    const round = Math.round(h * 10) / 10;
    return Number.isInteger(round) ? `in ${round.toFixed(0)}h` : `in ${round}h`;
  }
  const target = new Date(fireAt);
  return target.toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Whisper emits placeholder tokens when audio is silent/unintelligible.
 * Strip them. Also: Whisper notoriously hallucinates "Thank you." for silent
 * clips (it's all over its YouTube training data) — drop that, but only when
 * it's the entire utterance. Longer phrases that happen to contain "thank
 * you" are kept.
 */
function cleanTranscript(raw: string): string {
  const stripped = raw
    .replace(/\[\s*BLANK[_ ]AUDIO\s*\]/gi, '')
    .replace(/\[\s*INAUDIBLE\s*\]/gi, '')
    .replace(/\[\s*MUSIC\s*\]/gi, '')
    .replace(/\(\s*silence\s*\)/gi, '')
    .replace(/\(\s*music\s*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = stripped.toLowerCase().replace(/[.!?,;:'"-]+$/, '').trim();
  // Standalone hallucinations from silent or near-silent audio.
  if (normalized === '' || normalized === 'thank you' || normalized === 'you') {
    return '';
  }
  return stripped;
}

export function CommandPalette() {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<TranscribeProgress | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [projects, setProjects] = useState<ProjectDef[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(() =>
    readActiveProject(),
  );
  const [activeSkill, setActiveSkill] = useState<SkillSummary | null>(null);
  const [activeIntent, setActiveIntent] = useState<PendingIntent | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** Inline hint when the current text parses to a scheduled action/reminder. */
  const [schedulePreview, setSchedulePreview] = useState<{
    mode: 'reminder' | 'scheduled';
    fireAt: number;
    cron?: string;
  } | null>(null);
  /**
   * Command history index. -1 = current draft (whatever the user typed last),
   * 0 = most-recent past prompt, etc. Up/Down arrow cycles when the picker
   * isn't open. We snapshot the draft so Down past 0 restores it.
   */
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const draftRef = useRef<string>('');
  const [hintIdx, setHintIdx] = useState(0);
  const captureRef = useRef<AudioCapture | null>(null);
  /** Per-launch SDK option overrides — model / mode / extra dirs.
   * Persisted to localStorage so the user doesn't reset them every open. */
  const [sessionConfig, setSessionConfig] = useState<SessionConfig>(() =>
    loadSessionConfig(),
  );
  const updateSessionConfig = (patch: Partial<SessionConfig>) => {
    setSessionConfig((prev) => {
      const next = { ...prev, ...patch };
      // Strip undefined keys so the persisted blob stays small.
      for (const k of Object.keys(next) as Array<keyof SessionConfig>) {
        if (next[k] === undefined || next[k] === '') delete next[k];
      }
      saveSessionConfig(next);
      return next;
    });
  };
  const inputRef = useRef<HTMLInputElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.jarvis.listSkills().then(setSkills);
    void window.jarvis.listModules().then(setModules);
    void window.jarvis.listProjects().then(setProjects);
    const offS = window.jarvis.onSkillsChanged(setSkills);
    const offM = window.jarvis.onModulesChanged(setModules);
    const offP = window.jarvis.onTranscribeProgress((event) => {
      // Only render download/loading status while we're not idle.
      if (event.status === 'ready' || event.status === 'done') {
        setDownloadProgress(null);
      } else {
        setDownloadProgress(event);
      }
    });
    return () => {
      offS();
      offM();
      offP();
    };
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Re-read the active project every time the palette window is shown
  // (window 'focus' fires on each Cmd+Shift+J open). localStorage 'storage'
  // events don't fire in the same BrowserWindow that wrote them, so we rely
  // on focus for the cross-window sync.
  useEffect(() => {
    const sync = () => setActiveProject(readActiveProject());
    sync();
    window.addEventListener('focus', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('focus', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  // Cycle placeholder hints while idle. Stops once the user starts typing
  // or picks anything so we don't distract.
  useEffect(() => {
    if (text || activeSkill || activeIntent || listening || transcribing) return;
    const t = setInterval(() => {
      setHintIdx((i) => (i + 1) % PLACEHOLDER_HINTS.length);
    }, 4_000);
    return () => clearInterval(t);
  }, [text, activeSkill, activeIntent, listening, transcribing]);

  // Resize the palette window to fit its content. ResizeObserver fires
  // whenever the picker opens/closes, error appears, mic-progress shows,
  // etc. — the window grows and shrinks in lockstep, so there's no big
  // invisible-but-clickable empty area below the input.
  useEffect(() => {
    const el = paletteRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      // Add a hair of padding so a 1px rounding error doesn't clip
      // shadows or the bottom border of the picker.
      void window.jarvis.resizePalette(Math.ceil(rect.height) + 4);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const intents = useMemo<PaletteIntentSummary[]>(
    () => modules.flatMap((m) => m.intents),
    [modules],
  );

  // Shortest available alias for the active project. Notes / meetings parse
  // a leading "<alias>:" — using the shortest alias keeps the prefix tidy.
  const activeAlias = useMemo<string | null>(() => {
    if (!activeProject) return null;
    const def = projects.find((p) => p.name === activeProject);
    if (!def) return null;
    const candidates = [def.name, ...def.aliases];
    return candidates
      .slice()
      .sort((a, b) => a.length - b.length)[0] ?? null;
  }, [activeProject, projects]);

  // Does the raw text already start with a project alias? If so we don't
  // double-prefix when auto-scoping.
  const hasInlineProjectPrefix = (raw: string): boolean => {
    const m = raw.match(/^\s*([a-z0-9][a-z0-9 _-]{0,40}):\s/i);
    if (!m) return false;
    const candidate = m[1].toLowerCase().trim();
    return projects.some(
      (p) =>
        p.name.toLowerCase() === candidate ||
        p.aliases.some((a) => a.toLowerCase() === candidate),
    );
  };

  // Debounced preview: when the user is typing free text (no skill, no
  // intent, no slash), ask main whether it would route as a reminder /
  // scheduled action. Show a subtle hint when yes — so the user sees the
  // schedule *before* hitting Enter.
  useEffect(() => {
    if (activeSkill || activeIntent || text.startsWith('/') || !text.trim()) {
      setSchedulePreview(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      void window.jarvis.previewIntent(text).then((r) => {
        if (cancelled) return;
        if (r.kind === 'reminder') {
          setSchedulePreview({ mode: r.mode, fireAt: r.fireAt, cron: r.cron });
        } else {
          setSchedulePreview(null);
        }
      });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [text, activeSkill, activeIntent]);

  // If the user types a full intent prefix as the first word, promote it to
  // an active intent chip so Enter dispatches it (don't open the skill picker).
  useEffect(() => {
    if (activeIntent || activeSkill) return;
    if (!text.startsWith('/')) return;
    const firstSpace = text.indexOf(' ');
    if (firstSpace === -1) return;
    const prefix = text.slice(0, firstSpace);
    const match = intents.find((i) => i.prefix === prefix);
    if (match) {
      setActiveIntent(match);
      setText(text.slice(firstSpace + 1));
    }
  }, [text, intents, activeIntent, activeSkill]);

  const pickerOpen = text.startsWith('/') && !activeSkill && !activeIntent;
  const filter = pickerOpen ? text.slice(1).toLowerCase().trim() : '';

  type PickerRow =
    | { kind: 'intent'; value: PaletteIntentSummary }
    | { kind: 'skill'; value: SkillSummary };

  const matches = useMemo<PickerRow[]>(() => {
    if (!pickerOpen) return [];
    const tokens = filter.split(/\s+/).filter(Boolean);
    const head = tokens[0] ?? '';
    /**
     * Score a row against the tokens. All tokens must match somewhere
     * (substring) or we drop the row; on top of that, an exact / prefix
     * hit on the "anchor" field (intent prefix or skill name) bumps the
     * score so typing `/send` ranks `/send` above `/suggest-skills` even
     * though the latter's description contains the word "send".
     */
    const rowScore = (anchor: string, rest: string): number => {
      if (tokens.length === 0) return 1;
      const a = anchor.toLowerCase();
      const r = rest.toLowerCase();
      const haystack = `${a} ${r}`;
      if (!tokens.every((t) => haystack.includes(t))) return 0;
      // Highest band: anchor exactly matches the leading token.
      // Strip a leading slash on the anchor so `/send` vs `send` ties.
      const anchorBare = a.startsWith('/') ? a.slice(1) : a;
      const headBare = head.startsWith('/') ? head.slice(1) : head;
      if (anchorBare === headBare) return 100;
      if (anchorBare.startsWith(headBare)) return 80;
      if (a.includes(headBare)) return 60;
      if (r.startsWith(headBare)) return 40;
      return 20;
    };
    const intentRows = intents
      .map((value) => ({
        row: { kind: 'intent' as const, value },
        score: rowScore(value.prefix, `${value.label} ${value.description ?? ''}`),
      }))
      .filter((r) => r.score > 0);
    const skillRows = skills
      .map((value) => ({
        row: { kind: 'skill' as const, value },
        score: rowScore(value.name, value.description),
      }))
      .filter((r) => r.score > 0);
    // Intents win ties with skills (when the user typed a prefix
    // they're almost certainly going for the intent).
    intentRows.sort((a, b) => b.score - a.score);
    skillRows.sort((a, b) => b.score - a.score);
    return [...intentRows, ...skillRows].map((r) => r.row);
  }, [intents, skills, filter, pickerOpen]);

  useEffect(() => {
    if (pickerIndex >= matches.length) setPickerIndex(0);
  }, [matches.length, pickerIndex]);

  interface DispatchOverride {
    text?: string;
    intent?: PaletteIntentSummary | null;
    skill?: SkillSummary | null;
    origin?: 'palette' | 'voice';
  }

  const dispatch = async (override: DispatchOverride = {}) => {
    setError(null);
    const promptRaw = (override.text ?? text).trim();
    const intentForCall = override.intent !== undefined ? override.intent : activeIntent;
    const skillForCall = override.skill !== undefined ? override.skill : activeSkill;
    // Inject "<alias>: " when an active project is set, the user didn't
    // already type a project prefix, and the destination is a project-aware
    // intent or a free-text route.
    const projectAwareIntent =
      intentForCall != null &&
      ['quick-note', 'meeting-recorder'].includes(intentForCall.moduleId);
    const shouldScope =
      activeAlias != null &&
      promptRaw.length > 0 &&
      !hasInlineProjectPrefix(promptRaw) &&
      (intentForCall == null || projectAwareIntent) &&
      skillForCall == null;
    const prompt = shouldScope ? `${activeAlias}: ${promptRaw}` : promptRaw;
    // Reset history navigation on any successful dispatch.
    setHistoryIndex(-1);
    if (prompt) pushHistory(prompt);

    if (intentForCall) {
      try {
        const result = await window.jarvis.dispatchIntent(
          intentForCall.moduleId,
          intentForCall.id,
          prompt,
        );
        if (!result.ok) {
          setError(result.message ?? 'Intent failed');
          return;
        }
        setText('');
        setActiveIntent(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (!prompt && !skillForCall) return;
    try {
      // Skill-pinned launches always go straight to the runner — the
      // intent router would just see the prompt body without knowing
      // about the skill.
      if (skillForCall) {
        const summary = await window.jarvis.launchTask({
          prompt: prompt || 'Begin.',
          skillId: skillForCall.id,
          origin: override.origin ?? 'palette',
          ...sessionConfig,
        });
        setText('');
        setActiveSkill(null);
        void window.jarvis.showAnswerHud(summary.id);
        return;
      }
      // Free-text classifier in main:
      //   - verbal intent match ('record the meeting' → meeting module)
      //   - reminder/scheduled ('remind me in 2h …')
      //   - fall through to a Claude task
      const result = await window.jarvis.routePrompt(prompt, {
        origin: override.origin ?? 'palette',
        sessionConfig,
      });
      setText('');
      if (result.kind === 'task') {
        void window.jarvis.showAnswerHud(result.task.id);
      } else if (result.kind === 'intent' && !result.ok) {
        setError(result.message ?? 'Intent failed');
      }
      // Reminders + successful intents: main fires its own notification /
      // module side-effects (HUD pop, recording overlay, …). Nothing here.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const selectRow = (row: PickerRow) => {
    if (row.kind === 'skill') {
      setActiveSkill(row.value);
      setText('');
    } else {
      setActiveIntent(row.value);
      setText('');
    }
    setPickerIndex(0);
    setError(null);
    inputRef.current?.focus();
  };

  const startVoice = async () => {
    if (captureRef.current || transcribing) return;
    setError(null);
    try {
      const perm = await window.jarvis.requestMicAccess();
      if (!perm.granted) {
        setError(
          perm.status === 'denied'
            ? 'Microphone denied. Enable in System Settings → Privacy → Microphone → Jarvis.'
            : `Microphone unavailable (status: ${perm.status}).`,
        );
        return;
      }
    } catch (e) {
      console.warn('mic permission probe failed', e);
    }

    const capture = new AudioCapture();
    try {
      await capture.start();
    } catch (e) {
      setError(`Mic open failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    captureRef.current = capture;
    setListening(true);
  };

  const stopVoice = async () => {
    const capture = captureRef.current;
    if (!capture) return;
    captureRef.current = null;
    setListening(false);
    let result;
    try {
      result = await capture.stop();
    } catch (e) {
      setError(`Audio capture failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // Less than ~0.3s of audio — almost certainly an accidental tap, not a
    // real utterance. Skip the round-trip.
    if (result.pcm.length < 16_000 * 0.3) {
      setError("Didn't hear anything — hold the mic button while speaking.");
      return;
    }
    setTranscribing(true);
    try {
      const raw = await window.jarvis.transcribe(result.pcm.buffer as ArrayBuffer);
      const transcript = cleanTranscript(raw);
      if (!transcript) {
        setError("Couldn't make out the audio. Try again with less background noise.");
        return;
      }
      await routeVoiceCommand(transcript);
    } catch (e) {
      setError(`Transcribe failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTranscribing(false);
    }
  };

  /**
   * Voice route. Priority:
   *   1. Active skill or intent → submit using that.
   *   2. First word matches a module intent prefix → route to that intent.
   *   3. Free-form → launch a new task.
   *
   * Voice replies to an existing task happen in the Answer HUD, not here.
   */
  const routeVoiceCommand = async (transcript: string) => {
    if (activeSkill) {
      setText(transcript);
      await dispatch({ text: transcript, origin: 'voice' });
      return;
    }
    if (activeIntent) {
      setText(transcript);
      await dispatch({ text: transcript, origin: 'voice' });
      return;
    }
    const tokens = transcript.split(/\s+/);
    const firstWord = (tokens[0] ?? '').toLowerCase().replace(/[^a-z]/g, '');
    const matchedIntent = intents.find(
      (i) => i.prefix === `/${firstWord}` || i.id === firstWord,
    );
    if (matchedIntent) {
      const rest = tokens.slice(1).join(' ').trim();
      setText(rest);
      setActiveIntent(matchedIntent);
      await dispatch({ text: rest, intent: matchedIntent, origin: 'voice' });
      return;
    }
    setText(transcript);
    await dispatch({ text: transcript, origin: 'voice' });
  };

  const placeholder = listening
    ? 'Listening… release to transcribe'
    : transcribing
    ? 'Transcribing…'
    : downloadProgress?.status === 'downloading'
    ? `Loading whisper model ${downloadProgress.progress != null ? `· ${Math.round(downloadProgress.progress)}%` : ''}`
    : activeIntent
    ? activeIntent.placeholder ?? `${activeIntent.label}…`
    : activeSkill
    ? `${activeSkill.name} — add a prompt or press Enter`
    : PLACEHOLDER_HINTS[hintIdx] ?? '/ to pick · ask anything';

  const displayValue = text;

  return (
    <div className="palette palette-body" ref={paletteRef}>
      <div className="palette__inner">
        <span className="palette__prompt" aria-hidden>›</span>
        {activeAlias && !activeIntent && !activeSkill && (
          <span
            className="skill-chip skill-chip--project"
            title={`Scoped to ${activeProject}. Switch in the shell header.`}
          >
            {activeAlias}
            <button
              className="skill-chip__remove"
              onClick={() => {
                try {
                  window.localStorage.removeItem(ACTIVE_PROJECT_KEY);
                } catch {
                  // ignore
                }
                setActiveProject(null);
              }}
              title="Clear project scope for this prompt"
            >
              ×
            </button>
          </span>
        )}
        {activeIntent && (
          <span className="skill-chip skill-chip--intent">
            {activeIntent.label}
            <button
              className="skill-chip__remove"
              onClick={() => setActiveIntent(null)}
              title="Clear intent"
            >
              ×
            </button>
          </span>
        )}
        {activeSkill && (
          <span className="skill-chip">
            {activeSkill.name}
            <button
              className="skill-chip__remove"
              onClick={() => setActiveSkill(null)}
              title="Clear skill"
            >
              ×
            </button>
          </span>
        )}
        <input
          ref={inputRef}
          placeholder={placeholder}
          value={displayValue}
          onChange={(e) => {
            // Any direct edit takes us out of history-navigation mode so the
            // next Up arrow walks from "newest" again instead of one above
            // where we were.
            if (historyIndex !== -1) setHistoryIndex(-1);
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (pickerOpen && matches.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setPickerIndex((i) => (i + 1) % matches.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setPickerIndex((i) => (i - 1 + matches.length) % matches.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                const pick = matches[pickerIndex];
                if (pick) selectRow(pick);
                return;
              }
            }
            // Arrow-key history when not in the picker. Up = older, Down =
            // newer; Down past index 0 restores the draft the user had
            // before they started cycling.
            if (!pickerOpen && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              const history = loadHistory();
              if (history.length === 0) return;
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (historyIndex === -1) draftRef.current = text;
                const next = Math.min(history.length - 1, historyIndex + 1);
                setHistoryIndex(next);
                setText(history[next] ?? '');
                return;
              }
              if (e.key === 'ArrowDown' && historyIndex >= 0) {
                e.preventDefault();
                const next = historyIndex - 1;
                setHistoryIndex(next);
                setText(next === -1 ? draftRef.current : history[next] ?? '');
                return;
              }
            }
            if (e.key === 'Enter') void dispatch();
            if (e.key === 'Escape') {
              if (activeIntent) {
                setActiveIntent(null);
                return;
              }
              if (activeSkill) {
                setActiveSkill(null);
                return;
              }
              window.close();
            }
            if (e.key === 'Backspace' && !text) {
              if (activeIntent) setActiveIntent(null);
              else if (activeSkill) setActiveSkill(null);
            }
          }}
        />
        <button
          className={`mic${listening ? ' listening' : ''}${transcribing ? ' transcribing' : ''}`}
          title={
            transcribing
              ? 'Transcribing…'
              : listening
              ? 'Release to transcribe'
              : 'Hold to dictate'
          }
          onMouseDown={() => void startVoice()}
          onMouseUp={() => void stopVoice()}
          onMouseLeave={() => void stopVoice()}
          disabled={transcribing}
          aria-label="Toggle voice input"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="4" y="2" width="4" height="6" rx="2" stroke="currentColor" />
            <path d="M3 6.5C3 8 4 9 6 9C8 9 9 8 9 6.5" stroke="currentColor" strokeLinecap="round" />
            <line x1="6" y1="9" x2="6" y2="11" stroke="currentColor" strokeLinecap="round" />
          </svg>
        </button>
        <span className="hint">
          {schedulePreview ? (
            <span className="palette__schedule-hint" title="Press Enter to schedule">
              {schedulePreview.mode === 'scheduled' ? '⚡' : '⏰'}{' '}
              {schedulePreview.cron && '🔁 '}
              {formatScheduleHint(schedulePreview.fireAt)}
            </span>
          ) : (
            '↵ exec'
          )}
        </span>
      </div>
      <SessionConfigBar config={sessionConfig} onChange={updateSessionConfig} />
      {downloadProgress?.status === 'downloading' && (
        <div className="palette__progress">
          downloading whisper model
          {downloadProgress.file ? ` · ${downloadProgress.file}` : ''}
          {downloadProgress.progress != null && (
            <span className="palette__progress-bar">
              <span
                className="palette__progress-fill"
                style={{ width: `${Math.round(downloadProgress.progress)}%` }}
              />
            </span>
          )}
        </div>
      )}
      {error && <div className="palette__error">{error}</div>}
      {pickerOpen && matches.length > 0 && (
        <div className="skill-picker">
          {matches.map((row, i) => {
            const isActive = i === pickerIndex;
            const className = `skill-picker__row${
              isActive ? ' skill-picker__row--active' : ''
            }`;
            if (row.kind === 'intent') {
              return (
                <div
                  key={`intent-${row.value.moduleId}-${row.value.id}`}
                  className={className}
                  onMouseEnter={() => setPickerIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectRow(row);
                  }}
                >
                  <div className="skill-picker__name">
                    <span className="skill-picker__kind">module</span>
                    {row.value.prefix} · {row.value.label}
                  </div>
                  {row.value.description && (
                    <div className="skill-picker__desc">{row.value.description}</div>
                  )}
                </div>
              );
            }
            return (
              <div
                key={`skill-${row.value.id}`}
                className={className}
                onMouseEnter={() => setPickerIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectRow(row);
                }}
              >
                <div className="skill-picker__name">
                  <span className="skill-picker__kind">skill</span>
                  {row.value.name}
                </div>
                {row.value.description && (
                  <div className="skill-picker__desc">{row.value.description}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {pickerOpen && matches.length === 0 && (
        <div className="skill-picker">
          <div className="skill-picker__empty">
            No matches. Drop a SKILL.md or write a module.
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Three small chips below the palette input that override the SDK options
 * for the next launch: permission mode, model, and additional directories.
 * State is persisted to localStorage so the user doesn't reset them on
 * each open. Empty / unset = "use the runner's default" — mode falls back
 * to bypassPermissions, model to the skill frontmatter or SDK default.
 */
function SessionConfigBar({
  config,
  onChange,
}: {
  config: SessionConfig;
  onChange: (patch: Partial<SessionConfig>) => void;
}) {
  const [modeOpen, setModeOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [dirsOpen, setDirsOpen] = useState(false);
  const [recentDirs, setRecentDirs] = useState<string[]>(() => loadRecentDirs());

  const currentMode = config.permissionMode ?? 'bypassPermissions';
  const currentModeOpt =
    PERMISSION_MODE_OPTIONS.find((o) => o.value === currentMode) ??
    PERMISSION_MODE_OPTIONS[0]!;
  const currentModel = config.model ?? '';
  const currentModelOpt =
    MODEL_OPTIONS.find((o) => o.value === currentModel) ?? MODEL_OPTIONS[0]!;
  const activeDirs = config.additionalDirectories ?? [];
  const dirCount = activeDirs.length;

  // Make sure any dir currently active also lives in the recent list —
  // covers configs that pre-date the recent-dirs feature.
  useEffect(() => {
    if (activeDirs.length > 0) {
      const merged = addRecentDirs(activeDirs);
      if (merged.length !== recentDirs.length) setRecentDirs(merged);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDirs.length]);

  const toggleDir = (path: string) => {
    const cur = new Set(activeDirs);
    if (cur.has(path)) cur.delete(path);
    else cur.add(path);
    const next = Array.from(cur);
    onChange({ additionalDirectories: next.length > 0 ? next : undefined });
  };

  const pickNewDir = async () => {
    const picked = await window.jarvis.pickDirectory({ multi: true });
    if (!picked.length) return;
    setRecentDirs(addRecentDirs(picked));
    const merged = Array.from(new Set([...activeDirs, ...picked]));
    onChange({ additionalDirectories: merged });
  };

  const clearDirs = () =>
    onChange({ additionalDirectories: undefined });

  const removeRecent = (path: string) => {
    const next = recentDirs.filter((p) => p !== path);
    saveRecentDirs(next);
    setRecentDirs(next);
    // If this dir was active, deactivate it too.
    if (activeDirs.includes(path)) {
      const remaining = activeDirs.filter((p) => p !== path);
      onChange({
        additionalDirectories: remaining.length > 0 ? remaining : undefined,
      });
    }
  };

  return (
    <div className="session-config">
      <div className="session-config__chip-group">
        <button
          className={`session-config__chip${
            currentMode !== 'bypassPermissions' ? ' session-config__chip--set' : ''
          }`}
          onClick={() => {
            setModeOpen((v) => !v);
            setModelOpen(false);
          }}
          title={`Permission mode · ${currentModeOpt.hint}`}
        >
          <span className="session-config__chip-label">mode</span>
          <span className="session-config__chip-value">{currentModeOpt.label}</span>
        </button>
        {modeOpen && (
          <div className="session-config__menu">
            {PERMISSION_MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`session-config__menu-row${
                  opt.value === currentMode ? ' session-config__menu-row--active' : ''
                }`}
                onClick={() => {
                  onChange({ permissionMode: opt.value });
                  setModeOpen(false);
                }}
              >
                <div className="session-config__menu-label">{opt.label}</div>
                <div className="session-config__menu-hint">{opt.hint}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="session-config__chip-group">
        <button
          className={`session-config__chip${
            currentModel ? ' session-config__chip--set' : ''
          }`}
          onClick={() => {
            setModelOpen((v) => !v);
            setModeOpen(false);
          }}
          title={`Model · ${currentModelOpt.hint}`}
        >
          <span className="session-config__chip-label">model</span>
          <span className="session-config__chip-value">{currentModelOpt.label}</span>
        </button>
        {modelOpen && (
          <div className="session-config__menu">
            {MODEL_OPTIONS.map((opt) => (
              <button
                key={opt.value || 'default'}
                className={`session-config__menu-row${
                  opt.value === currentModel ? ' session-config__menu-row--active' : ''
                }`}
                onClick={() => {
                  onChange({ model: opt.value || undefined });
                  setModelOpen(false);
                }}
              >
                <div className="session-config__menu-label">{opt.label}</div>
                <div className="session-config__menu-hint">{opt.hint}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="session-config__chip-group">
        <button
          className={`session-config__chip${
            dirCount > 0 ? ' session-config__chip--set' : ''
          }`}
          onClick={() => {
            setDirsOpen((v) => !v);
            setModeOpen(false);
            setModelOpen(false);
          }}
          title={
            dirCount > 0
              ? `${dirCount} extra dir${dirCount === 1 ? '' : 's'}: ${activeDirs.join(', ')}`
              : 'Add directories the agent can read/write beyond cwd'
          }
        >
          <span className="session-config__chip-label">+dirs</span>
          <span className="session-config__chip-value">
            {dirCount > 0 ? dirCount : '—'}
          </span>
        </button>
        {dirsOpen && (
          <div className="session-config__menu session-config__menu--dirs">
            {recentDirs.length === 0 ? (
              <div className="session-config__menu-empty">
                No folders picked yet.
              </div>
            ) : (
              recentDirs.map((path) => {
                const checked = activeDirs.includes(path);
                return (
                  <div
                    key={path}
                    className={`session-config__dir-row${checked ? ' session-config__dir-row--on' : ''}`}
                  >
                    <button
                      className="session-config__dir-toggle"
                      onClick={() => toggleDir(path)}
                      title={checked ? 'Remove from this launch' : 'Add to this launch'}
                    >
                      <span className="session-config__dir-check">
                        {checked ? '✓' : ' '}
                      </span>
                      <span className="session-config__dir-path" title={path}>
                        {compactPath(path)}
                      </span>
                    </button>
                    <button
                      className="session-config__dir-remove"
                      onClick={() => removeRecent(path)}
                      title="Forget this folder"
                      aria-label="Forget this folder"
                    >
                      ×
                    </button>
                  </div>
                );
              })
            )}
            <button
              className="session-config__menu-row session-config__menu-row--add"
              onClick={() => {
                setDirsOpen(false);
                void pickNewDir();
              }}
            >
              <div className="session-config__menu-label">+ Add new folder…</div>
              <div className="session-config__menu-hint">
                Opens the native folder picker
              </div>
            </button>
            {dirCount > 0 && (
              <button
                className="session-config__menu-row session-config__menu-row--clear"
                onClick={() => {
                  clearDirs();
                  setDirsOpen(false);
                }}
              >
                <div className="session-config__menu-label">Clear selection</div>
                <div className="session-config__menu-hint">
                  Untick all; recents stay
                </div>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Shrink a long path for display in the chip dropdown — keep the last
 * two segments + truncate the home prefix. The full path is in `title`. */
function compactPath(path: string): string {
  const home = path.match(/^\/Users\/[^/]+/);
  const stripped = home ? '~' + path.slice(home[0].length) : path;
  if (stripped.length <= 50) return stripped;
  const segs = stripped.split('/');
  if (segs.length <= 3) return stripped;
  return `${segs[0]}/…/${segs.slice(-2).join('/')}`;
}
