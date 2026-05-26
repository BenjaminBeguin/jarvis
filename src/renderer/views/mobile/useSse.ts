import { useEffect, useRef, useState } from 'react';

import { sseUrl } from './api';
import type { MobileAuth } from './types';

export interface SseHandlers {
  onStatus?: (payload: unknown) => void;
  onNotif?: (payload: unknown) => void;
  onTaskStatus?: (payload: unknown) => void;
  /** Active meeting recording state, pushed on connect + on every
   *  start/pause/resume/stop transition. Mirrors the renderer's
   *  MeetingRecorder.state shape. */
  onMeetingState?: (payload: unknown) => void;
}

/**
 * Subscribe to `GET /v1/status/live` (SSE). Reconnects on drop
 * (EventSource handles it natively). Returns a `connected` flag
 * for the header pill so the user sees when the phone is in
 * sync vs. offline.
 *
 * The handlers are read from a ref so callers can pass inline
 * lambdas without resubscribing every render.
 */
export function useSse(
  auth: MobileAuth,
  handlers: SseHandlers,
): { connected: boolean } {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const url = sseUrl(auth, '/v1/status/live');
    const es = new EventSource(url);
    es.addEventListener('open', () => setConnected(true));
    es.addEventListener('error', () => setConnected(false));
    es.addEventListener('status', (e) => {
      try {
        handlersRef.current.onStatus?.(JSON.parse(e.data));
      } catch (err) {
        console.warn('[sse] bad status payload', err);
      }
    });
    es.addEventListener('notif', (e) => {
      try {
        handlersRef.current.onNotif?.(JSON.parse(e.data));
      } catch (err) {
        console.warn('[sse] bad notif payload', err);
      }
    });
    es.addEventListener('task.status', (e) => {
      try {
        handlersRef.current.onTaskStatus?.(JSON.parse(e.data));
      } catch (err) {
        console.warn('[sse] bad task.status payload', err);
      }
    });
    es.addEventListener('meeting.state', (e) => {
      try {
        handlersRef.current.onMeetingState?.(JSON.parse(e.data));
      } catch (err) {
        console.warn('[sse] bad meeting.state payload', err);
      }
    });
    return () => {
      es.close();
      setConnected(false);
    };
  }, [auth.baseUrl, auth.token]);

  return { connected };
}
