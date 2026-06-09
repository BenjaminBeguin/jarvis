import { useEffect, useRef, useState } from 'react';

/**
 * CommandRail — a HUD-style "talk to Jarvis" input pinned at the
 * top of the Bridge. Pressing Enter dispatches via routePrompt (same
 * gateway as the floating palette ⌘⇧J). The floating palette is still
 * the primary keyboard-driven entry point — this rail exists so the
 * Bridge feels like a *workstation* with a command line, not a status
 * board.
 *
 * Affordances:
 *   - Enter        → routePrompt(value, origin: 'palette')
 *   - ⌘K / Ctrl+K  → focus the rail without opening the floating palette
 *   - Empty + Enter on ⌘⇧J shortcut already opens the floating palette,
 *     which is fine — this rail is the *visible* surface.
 *
 * Iron-Man HUD aesthetic: bracket markers, a blinking caret-prompt
 * prefix `[J]>`, faint scanline underneath when focused.
 */
export function CommandRail() {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ⌘K / Ctrl+K focuses the inline rail (vs ⌘⇧J which opens the
  // floating palette window). Stops short of preventing the user's
  // typing focus on form elements elsewhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        const active = document.activeElement as HTMLElement | null;
        const inField =
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          (active && active.isContentEditable);
        // Field already focused → let the OS handle ⌘K (link toolbar etc.).
        if (inField && active !== inputRef.current) return;
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = async (): Promise<void> => {
    const text = value.trim();
    if (!text || busy) return;
    setBusy(true);
    setHint(null);
    try {
      const result = await window.jarvis.routePrompt(text, { origin: 'palette' });
      setValue('');
      // Light feedback so the user knows the dispatch landed
      // without yanking them off the Bridge.
      if (result.kind === 'task') {
        setHint(`▶ task launched`);
      } else if (result.kind === 'reminder') {
        setHint(`⏰ reminder set`);
      } else if (result.kind === 'intent') {
        setHint(
          result.ok ? `✓ ${result.message ?? 'done'}` : `✗ ${result.message ?? 'failed'}`,
        );
      }
      setTimeout(() => setHint(null), 2500);
    } catch (err) {
      setHint(`✗ ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => setHint(null), 4000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bridge-rail">
      <span className="bridge-rail__prompt">[J]&gt;</span>
      <input
        ref={inputRef}
        className="bridge-rail__input"
        type="text"
        value={value}
        placeholder={
          busy
            ? 'dispatching…'
            : 'ask, command, or describe — ⌘K to focus, ↵ to send'
        }
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {hint && <span className="bridge-rail__hint">{hint}</span>}
    </div>
  );
}
