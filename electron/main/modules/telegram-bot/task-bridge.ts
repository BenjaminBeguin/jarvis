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
}

export class TaskBridge {
  private byTask = new Map<string, TaskBridgeEntry>();
  /** message_id (Telegram side) → task id. Lets reply-detection find the
   *  task a user reply belongs to. */
  private byMessage = new Map<number, string>();
  /** chatId → most recently launched taskId, used for /abort without
   *  a reply-to context. */
  private lastTaskByChat = new Map<number, string>();

  register(taskId: string, chatId: number): void {
    this.byTask.set(taskId, { chatId });
    this.lastTaskByChat.set(chatId, taskId);
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
