import { useEffect, useRef, useState } from 'react';

import { createTranscriber, isVoiceSupported, type VoiceTranscriber } from '../voice/WebSpeechTranscriber';

export function CommandPalette() {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const transcriberRef = useRef<VoiceTranscriber | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const launch = async (value: string) => {
    const prompt = value.trim();
    if (!prompt) return;
    try {
      await window.jarvis.launchTask({ prompt, origin: 'palette' });
      setText('');
      setPartial('');
    } catch (e) {
      console.error('launch failed', e);
    }
  };

  const startVoice = () => {
    if (transcriberRef.current) return;
    const t = createTranscriber({
      onPartial: (txt) => setPartial(txt),
      onFinal: (txt) => {
        setText((prev) => (prev ? `${prev} ${txt}` : txt));
        setPartial('');
      },
      onError: (msg) => {
        console.warn('voice error', msg);
        setListening(false);
      },
      onEnd: () => {
        setListening(false);
        transcriberRef.current = null;
      },
    });
    if (!t) return;
    transcriberRef.current = t;
    t.start();
    setListening(true);
  };

  const stopVoice = () => {
    transcriberRef.current?.stop();
  };

  return (
    <div className="palette palette-body">
      <div className="palette__inner">
        <input
          ref={inputRef}
          placeholder={listening ? (partial || 'Listening…') : 'Ask Jarvis…'}
          value={listening && partial ? partial : text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void launch(text);
            if (e.key === 'Escape') window.close();
          }}
        />
        {isVoiceSupported() && (
          <button
            className={`mic${listening ? ' listening' : ''}`}
            title={listening ? 'Stop listening' : 'Hold to dictate'}
            onMouseDown={startVoice}
            onMouseUp={stopVoice}
            onMouseLeave={stopVoice}
          >
            ●
          </button>
        )}
        <span className="hint">↵ run</span>
      </div>
    </div>
  );
}
