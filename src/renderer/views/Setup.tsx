import { useState } from 'react';

export function Setup() {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await window.jarvis.setApiKey(value);
      setValue('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup">
      <h2>Welcome to Jarvis</h2>
      <p>
        Paste your Anthropic API key. It's stored in your macOS Keychain and never
        leaves your machine.
      </p>
      <div className="row">
        <input
          type="password"
          autoFocus
          placeholder="sk-ant-…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        <button onClick={submit} disabled={busy || !value.trim()}>
          Save
        </button>
      </div>
      {error && (
        <p style={{ color: 'var(--bad)', fontSize: 12 }}>{error}</p>
      )}
    </div>
  );
}
