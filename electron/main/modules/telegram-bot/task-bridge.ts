/**
 * Maps in two directions:
 *
 *   1. Telegram message id → task id: when the user replies to a previous
 *      bot message, look up which running task that message belonged to so
 *      we can route the reply through `runner.sendMessage(taskId, …)`.
 *
 *   2. Task id → { chatId, lastBotMessageId }: when a task fires events
 *      (awaiting input, complete, errored), we need to know which Telegram
 *      chat to forward to. `lastBotMessageId` is the bot's most recent
 *      message in the conversation — used for "Edit…" inline-button flows
 *      where the user's next message is expected as a reply.
 *
 * Both maps live in memory only. On Electron restart, all tracked tasks
 * are lost (they were likely ephemeral anyway). Persisting across restart
 * is a Phase 2 problem if it matters.
 */
export interface TaskBridgeEntry {
  chatId: number;
  /** Latest bot message id in this chat for this task. Updated every
   *  time the bot sends a reply for the task. */
  lastBotMessageId?: number;
  /** Telegram-side timestamp of the last user message we processed for
   *  this task. Lets us drop late retries / duplicates if needed. */
  lastUserMessageAt?: number;
  /** ms epoch — when the bridge last sent a turn on this task. Drives
   *  the staleness check for "should next user message continue this
   *  task or fork a fresh one." */
  lastUsedAt: number;
  /** How many turns this bridged task has handled. Caps reuse before
   *  the auto-compacted context summary starts costing more per turn
   *  than the cold start a fresh task would pay. */
  turnCount: number;
  /** Project scope this thread is bound to. Lets a single chat keep
   *  separate threads per project — "cs-ai: ..." opens a cs-ai
   *  thread, "personal: ..." opens a personal thread, no prefix
   *  continues the current scope. null = unscoped general thread. */
  projectName: string | null;
}

export class TaskBridge {
  private byTask = new Map<string, TaskBridgeEntry>();
  /** message_id (Telegram side) → task id. Lets reply-detection find the
   *  task a user reply belongs to. */
  private byMessage = new Map<number, string>();
  /** chatId → most recently launched taskId, used for /abort without
   *  a reply-to context. */
  private lastTaskByChat = new Map<number, string>();

  register(
    taskId: string,
    chatId: number,
    projectName: string | null = null,
  ): void {
    this.byTask.set(taskId, {
      chatId,
      lastUsedAt: Date.now(),
      turnCount: 1,
      projectName,
    });
    this.lastTaskByChat.set(chatId, taskId);
  }

  /** Bump lastUsedAt + turn count after we forwarded another user
   *  message into this task. Called from continueTask. */
  recordTurn(taskId: string): void {
    const entry = this.byTask.get(taskId);
    if (!entry) return;
    entry.lastUsedAt = Date.now();
    entry.turnCount += 1;
  }

  linkMessageToTask(messageId: number, taskId: string): void {
    this.byMessage.set(messageId, taskId);
    const entry = this.byTask.get(taskId);
    if (entry) entry.lastBotMessageId = messageId;
  }

  taskForReply(repliedToMessageId: number): string | null {
    return this.byMessage.get(repliedToMessageId) ?? null;
  }

  get(taskId: string): TaskBridgeEntry | null {
    return this.byTask.get(taskId) ?? null;
  }

  has(taskId: string): boolean {
    return this.byTask.has(taskId);
  }

  lastTaskFor(chatId: number): string | null {
    return this.lastTaskByChat.get(chatId) ?? null;
  }

  /** Return the chat's active task for the given project scope, only
   *  when still eligible to continue — fresh enough + under the turn
   *  cap. Project matching is exact (null === null counts as match).
   *  Returns null when no thread matches (caller forks a new task).
   *
   *  If `projectName` is null, prefers the chat's most recent thread
   *  regardless of scope — "no explicit project mentioned → continue
   *  whatever we were just talking about." If `projectName` is set,
   *  it must match exactly: "cs-ai: ..." won't graft onto a
   *  personal-scoped thread. */
  getActiveTaskFor(
    chatId: number,
    projectName: string | null,
    maxAgeMs: number,
    maxTurns: number,
  ): string | null {
    const isFresh = (entry: TaskBridgeEntry): boolean =>
      entry.turnCount < maxTurns &&
      Date.now() - entry.lastUsedAt <= maxAgeMs;

    // Explicit project ask: only match an entry with that exact scope.
    if (projectName !== null) {
      for (const [taskId, entry] of this.byTask) {
        if (entry.chatId !== chatId) continue;
        if (entry.projectName !== projectName) continue;
        if (!isFresh(entry)) continue;
        return taskId;
      }
      return null;
    }
    // No explicit project: continue the chat's most recent thread if
    // it's still fresh, whatever its scope. That gives "I'm in the
    // middle of a cs-ai conversation, my next reply should keep going"
    // even when I don't re-type the prefix.
    const lastId = this.lastTaskByChat.get(chatId);
    if (!lastId) return null;
    const last = this.byTask.get(lastId);
    if (!last || !isFresh(last)) return null;
    return lastId;
  }

  /** Drop the entry. Used when a task completes / errors / aborts so
   *  the maps don't grow unbounded across a long session. */
  forget(taskId: string): void {
    const entry = this.byTask.get(taskId);
    if (!entry) return;
    this.byTask.delete(taskId);
    if (this.lastTaskByChat.get(entry.chatId) === taskId) {
      this.lastTaskByChat.delete(entry.chatId);
    }
    // Sweep byMessage entries pointing at this task. Linear scan but
    // bounded by the number of bot replies in this conversation —
    // typically < 20.
    for (const [msgId, tid] of this.byMessage) {
      if (tid === taskId) this.byMessage.delete(msgId);
    }
  }

  /** Reset everything. Used on module unload. */
  clear(): void {
    this.byTask.clear();
    this.byMessage.clear();
    this.lastTaskByChat.clear();
  }
}
