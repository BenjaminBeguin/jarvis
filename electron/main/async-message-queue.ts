import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Async queue of user messages, consumable as an AsyncIterable. The Agent
 * SDK's query() accepts this shape for `prompt` and keeps the generation
 * loop alive — pushing more messages after the first turn continues the
 * same Task instead of starting a new one.
 *
 * close() ends the iteration and lets query() finish cleanly. Calling
 * push() after close is a no-op.
 */
export class AsyncMessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private pendingResolver: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const resolver = this.pendingResolver;
    if (resolver) {
      this.pendingResolver = null;
      resolver({ value: message, done: false });
    } else {
      this.queued.push(message);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const resolver = this.pendingResolver;
    if (resolver) {
      this.pendingResolver = null;
      resolver({ value: undefined as never, done: true });
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const buffered = this.queued.shift();
        if (buffered) {
          return Promise.resolve({ value: buffered, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.pendingResolver = resolve;
        });
      },
      return: (): Promise<IteratorResult<SDKUserMessage>> => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
