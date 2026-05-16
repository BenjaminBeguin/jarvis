import { Telegraf, type Context, type NarrowedContext } from 'telegraf';
import type { Message, Update } from 'telegraf/types';

import type { ModuleContext } from '../types.js';
import type { NotificationEvent, NotificationSource } from '../../notifier.js';
import { notifier } from '../../notifier.js';

import { TaskBridge } from './task-bridge.js';
import { transcribeOgg } from './transcribe-ogg.js';

type TextContext = NarrowedContext<Context, Update.MessageUpdate<Message.TextMessage>>;
type VoiceContext = NarrowedContext<Context, Update.MessageUpdate<Message.VoiceMessage>>;
/** Telegraf adds `.match` (the RegExp result) onto the ctx for `bot.action(/regex/)`
 *  handlers but its public type doesn't surface it. Local type fills the gap. */
type ActionContext = Context & { match: RegExpExecArray };

/** Live config snapshot read on-demand from disk via the supplied
 *  reader. Lets the user change the allowlist or notification level
 *  in Settings without forcing a module reload. The bot token is
 *  captured once at construction (reload is needed to swap tokens). */
export interface TelegramBotLiveConfig {
  allowedChatIds: number[];
  primaryChatId: number | null;
  notifications: 'all' | 'reminders' | 'custom' | 'off';
  /** Per-topic toggles. Only consulted when notifications === 'custom'. */
  customTopics: {
    reminder: boolean;
    scheduledAction: boolean;
    taskAwaiting: boolean;
    costGuardrail: boolean;
    taskComplete: boolean;
    taskErrored: boolean;
    meetingHeadsUp: boolean;
    inboxNew: boolean;
    notifyTool: boolean;
  };
}

export interface TelegramBotConfig {
  token: string;
  readLive: () => TelegramBotLiveConfig;
}

const TELEGRAM_MESSAGE_LIMIT = 4096;
const REPLY_TIMEOUT_MS = 180_000;
/** How long the bridge keeps a chat's agent task after the last
 *  message in. The clock resets on every turn, so this is really
 *  "how long of total silence before we fork fresh." 7 days lets
 *  a Telegram thread survive weekends + week-long travel — the
 *  agent remembers your prior context whenever you come back. The
 *  SDK auto-compacts long contexts as they grow, so token overflow
 *  handles itself; we don't need a tighter window. Fork manually
 *  with /new when you're starting a different topic. */
const TELEGRAM_AGENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Soft ceiling on turns per task. Set high so back-and-forth chats
 *  feel unbounded (Claude.ai parity). Auto-compacted summaries grow
 *  turn-over-turn, but the per-turn cost stays reasonable up to a
 *  few hundred turns. Use /new in the bot to fork early if a thread
 *  is getting expensive or you're switching topics. */
const TELEGRAM_AGENT_TURN_CAP = 500;

/**
 * Long-polling Telegram bot wired to Jarvis. See plan.md / SKILL design
 * doc for the three inbound paths (new message / reply / inline button)
 * and the AFK-aware outbound flow.
 */
export class TelegramBot {
  private bot: Telegraf;
  private bridge = new TaskBridge();
  private unsubscribeNotifier?: () => void;
  /** chatId → taskId, set when user taps [Edit…] and the next text/voice
   *  in that chat should resume the task (whether the user replies-to
   *  the bot or just types fresh). One-shot per click. */
  private editAwaiting = new Map<number, string>();

  constructor(
    private ctx: ModuleContext,
    private config: TelegramBotConfig,
  ) {
    this.bot = new Telegraf(config.token);
  }

  async launch(): Promise<void> {
    // Validate the token up front so a bad value fails the onLoad call
    // instead of silently looping a 401 long-poll.
    await this.bot.telegram.getMe();

    this.registerHandlers();
    this.unsubscribeNotifier = notifier.subscribe((e) => {
      void this.handleNotification(e).catch((err) =>
        console.warn('[telegram-bot] notification forward failed:', err),
      );
    });

    // Telegraf's launch() polls until stop() is called. Don't await —
    // it would block onLoad indefinitely. Surface startup errors via
    // logs; subsequent failures retry inside Telegraf's loop.
    void this.bot.launch().catch((err) => {
      console.error('[telegram-bot] launch loop exited:', err);
    });
  }

  async stop(): Promise<void> {
    this.unsubscribeNotifier?.();
    this.unsubscribeNotifier = undefined;
    try {
      this.bot.stop();
    } catch {
      // bot.stop() throws if already stopped. Idempotent.
    }
    this.bridge.clear();
    this.editAwaiting.clear();
  }

  // ─── handler registration ─────────────────────────────────────────────

  private registerHandlers(): void {
    this.bot.command('start', (ctx) => this.handleStart(ctx));
    this.bot.command('skills', (ctx) => this.handleSkills(ctx));
    this.bot.command('status', (ctx) => this.handleStatusCmd(ctx));
    this.bot.command('abort', (ctx) => this.handleAbort(ctx));
    this.bot.command('afk', (ctx) => this.handleAfkCmd(ctx));
    this.bot.command('pause', (ctx) => this.handlePauseCmd(ctx, true));
    this.bot.command('resume', (ctx) => this.handlePauseCmd(ctx, false));
    this.bot.command('spend', (ctx) => this.handleSpendCmd(ctx));
    this.bot.command('new', (ctx) => this.handleNewCmd(ctx));

    this.bot.on('text', (ctx) => this.handleText(ctx as TextContext));
    this.bot.on('voice', (ctx) => this.handleVoice(ctx as VoiceContext));

    this.bot.action(/^approve:(.+)$/, (ctx) =>
      this.handleApprove(ctx as unknown as ActionContext),
    );
    this.bot.action(/^cancel:(.+)$/, (ctx) =>
      this.handleCancel(ctx as unknown as ActionContext),
    );
    this.bot.action(/^edit:(.+)$/, (ctx) =>
      this.handleEdit(ctx as unknown as ActionContext),
    );
    this.bot.action(/^rem_done:(.+)$/, (ctx) =>
      this.handleReminderDone(ctx as unknown as ActionContext),
    );
    this.bot.action(/^rem_snooze:(.+):(.+)$/, (ctx) =>
      this.handleReminderSnooze(ctx as unknown as ActionContext),
    );

    this.bot.catch((err) => {
      console.error('[telegram-bot] unhandled error:', err);
    });
  }

  // ─── command handlers ─────────────────────────────────────────────────

  private async handleStart(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== 'number') return;
    const chatType = ctx.chat?.type; // 'private' | 'group' | 'supergroup' | 'channel'
    // /start is the discovery flow — never allowlist-gated, otherwise
    // the user can't find out their chat id to add it.
    if (this.isAllowed(chatId)) {
      await ctx.reply(
        `You're connected. Chat id: \`${chatId}\` (${chatType ?? 'unknown'}).\n\nText or voice notes continue the same agent thread for up to 7 days. Prefix with \`<project>:\` (e.g. \`cs-ai: …\`) to switch to that project's thread — no prefix continues whatever we were just talking about. /new forks a fresh thread. Other commands: /skills, /status, /spend, /afk, /pause.`,
        { parse_mode: 'Markdown' },
      );
      return;
    }
    const lines = [
      `Your chat id is \`${chatId}\`.`,
      '',
      'To enable two-way control:',
      '1. In Jarvis on your Mac, open Settings → Modules → Telegram bot.',
      '2. Paste this number into "Allowed chat IDs".',
      '3. Save.',
      '',
      'Then come back here and send any text or voice note to run a Jarvis task.',
    ];
    if (chatType && chatType !== 'private') {
      lines.unshift(
        `(You\'re messaging me from a ${chatType}. That\'s fine — Jarvis will accept messages from anyone in this ${chatType} once you allow this chat id. For a personal setup, message me in a 1-on-1 DM instead and use that chat id.)`,
        '',
      );
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  }

  private async handleSkills(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== 'number' || !this.isAllowed(chatId)) return;
    const skills = this.ctx.listSkills();
    if (skills.length === 0) {
      await ctx.reply('No skills configured.');
      return;
    }
    const lines = skills.slice(0, 60).map((s) => `• *${s.name}* — ${s.description || s.id}`);
    const more =
      skills.length > 60 ? `\n…and ${skills.length - 60} more.` : '';
    await ctx.reply(`*Available skills*\n${lines.join('\n')}${more}`, {
      parse_mode: 'Markdown',
    });
  }

  private async handleStatusCmd(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== 'number' || !this.isAllowed(chatId)) return;
    await this.dispatchAsNewMessage(chatId, ctx, '/status');
  }

  private async handleAbort(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== 'number' || !this.isAllowed(chatId)) return;
    const taskId = this.bridge.lastTaskFor(chatId);
    if (!taskId) {
      await ctx.reply('No recent task to abort.');
      return;
    }
    try {
      await this.ctx.abortTask(taskId);
      await ctx.reply(`Aborted task ${taskId}.`);
    } catch (err) {
      await ctx.reply(`Could not abort: ${(err as Error).message}`);
    }
  }

  /**
   * /pause and /resume — global Jarvis pause toggle. From your phone
   * you can stop every routine + scheduled-action reminder. Use
   * /resume when you're back. /pause status prints the current state.
   */
  private async handlePauseCmd(ctx: Context, paused: boolean): Promise<void> {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== 'number' || !this.isAllowed(chatId)) return;
    if (this.ctx.isPaused() === paused) {
      await ctx.reply(
        paused
          ? 'Jarvis is already paused.'
          : 'Jarvis is already active.',
      );
      return;
    }
    this.ctx.setPaused(paused);
    await ctx.reply(
      paused
        ? '⏸ Jarvis paused. Routines + scheduled actions will skip until /resume.'
        : '▶ Jarvis resumed. Routines + scheduled actions fire on their normal cadence.',
    );
  }

  /**
   * /new — fork the current agent thread for this chat. The next
   * message starts a fresh task; the prior task stays available in
   * the Observatory but stops receiving new turns here. The
   * Claude.ai "New chat" equivalent.
   */
  private async handleNewCmd(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== 'number' || !this.isAllowed(chatId)) return;
    const prior = this.bridge.lastTaskFor(chatId);
    if (prior) this.bridge.forget(prior);
    await ctx.reply(
      prior
        ? '🔄 Fresh thread. Your next message starts a new agent — the prior conversation is still in the Observatory if you need to look back.'
        : 'No active thread to fork — your next message will start a new agent.',
    );
  }

  /**
   * /spend — current spend digest. Sent in-line (no agent fired) so
   * it's fast and cheap, even if Jarvis is paused. Format prioritises
   * info you actually want from the phone: today's $, the 7-day total,
   * and the top 3 skills so you can immediately see what's burning.
   */
  private async handleSpendCmd(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== 'number' || !this.isAllowed(chatId)) return;
    try {
      const today = this.ctx.getCostBreakdown(1);
      const week = this.ctx.getCostBreakdown(7);
      const lines: string[] = [];
      lines.push(`*Today:* $${today.total.toFixed(2)} · ${today.bySkill.reduce((s, r) => s + r.taskCount, 0)} tasks`);
      lines.push(`*Last 7 days:* $${week.total.toFixed(2)}`);
      const top = week.bySkill.slice(0, 3);
      if (top.length > 0) {
        lines.push('');
        lines.push('*Top skills (7d):*');
        for (const r of top) {
          const label = r.skillId ?? '(free-text)';
          lines.push(`• ${label}: $${r.totalUsd.toFixed(2)} (${r.taskCount})`);
        }
      }
      const pooledRatio = (() => {
        const total = week.pool.pooledTaskCount + week.pool.freshTaskCount;
        if (total === 0) return null;
        return Math.round((week.pool.pooledTaskCount / total) * 100);
      })();
      if (pooledRatio !== null) {
        lines.push('');
        lines.push(`Pooled ${pooledRatio}% of palette/voice turns this week.`);
      }
      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`Could not read spend: ${(err as Error).message}`);
    }
  }

  private async handleAfkCmd(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== 'number' || !this.isAllowed(chatId)) return;
    const text = (ctx.message as Message.TextMessage | undefined)?.text ?? '';
    const arg = text.replace(/^\/afk(?:@\S+)?\s*/i, '').trim().toLowerCase();
    if (arg === 'on' || arg === 'true' || arg === '1') {
      this.ctx.setAfk(true);
      await ctx.reply('AFK mode: on. Mirroring more events to this chat.');
    } else if (arg === 'off' || arg === 'false' || arg === '0') {
      this.ctx.setAfk(false);
      await ctx.reply('AFK mode: off.');
    } else if (arg === '' || arg === 'status') {
      await ctx.reply(`AFK mode is currently *${this.ctx.isAfk() ? 'on' : 'off'}*.`, {
        parse_mode: 'Markdown',
      });
    } else {
      await ctx.reply('Usage: /afk on | off');
    }
  }

  // ─── text + voice handlers ────────────────────────────────────────────

  private async handleText(ctx: TextContext): Promise<void> {
    const chatId = ctx.chat.id;
    if (!this.isAllowed(chatId)) return;
    const text = ctx.message.text;
    // Skip texts that look like our own commands — they're routed via
    // the command handlers above.
    if (text.startsWith('/')) return;

    await this.handleUserMessage(ctx, chatId, text, ctx.message.reply_to_message);
  }

  private async handleVoice(ctx: VoiceContext): Promise<void> {
    const chatId = ctx.chat.id;
    if (!this.isAllowed(chatId)) return;

    let transcript: string;
    try {
      await ctx.sendChatAction('typing');
      const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
      const res = await fetch(fileLink.toString());
      if (!res.ok) throw new Error(`Telegram file fetch ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      transcript = await transcribeOgg(buf);
    } catch (err) {
      await ctx.reply(`Couldn't transcribe voice note: ${(err as Error).message}`);
      return;
    }
    if (!transcript.trim()) {
      await ctx.reply("Couldn't hear anything in that voice note.");
      return;
    }
    await ctx.reply(`_${transcript}_`, { parse_mode: 'Markdown' });
    await this.handleUserMessage(ctx, chatId, transcript, ctx.message.reply_to_message);
  }

  private async handleUserMessage(
    ctx: Context,
    chatId: number,
    text: string,
    replyTo: Message | undefined,
  ): Promise<void> {
    // 1. Edit-awaiting path: user just clicked [Edit…] in a previous
    //    button row, anything they send next continues that task.
    const editTaskId = this.editAwaiting.get(chatId);
    if (editTaskId) {
      this.editAwaiting.delete(chatId);
      await this.continueTask(ctx, chatId, editTaskId, text);
      return;
    }
    // 2. Reply path: user is replying to a prior bot message tied to a
    //    running task. Continue that task instead of starting fresh.
    if (replyTo) {
      const taskId = this.bridge.taskForReply(replyTo.message_id);
      if (taskId) {
        await this.continueTask(ctx, chatId, taskId, text);
        return;
      }
    }
    // 3. Project-scope detection: "alias: rest" prefix routes to a
    //    project-scoped thread. Lets one Telegram chat hold separate
    //    threads per project ("cs-ai: ..." vs "personal: ..." vs no
    //    prefix). The prefix is stripped from the prompt before
    //    routing — the agent shouldn't have to parse it again.
    const scope = this.extractProjectScope(text);
    const promptText = scope?.stripped ?? text;
    const explicitProject = scope?.projectName ?? null;
    // 4. Persistent-agent path: continue the chat's existing thread
    //    when the scope matches (or no explicit scope was given —
    //    "continue whatever we were just talking about"). A new
    //    explicit scope that doesn't match the current thread falls
    //    through to a fresh dispatch tagged with that project.
    const activeTaskId = this.bridge.getActiveTaskFor(
      chatId,
      explicitProject,
      TELEGRAM_AGENT_TTL_MS,
      TELEGRAM_AGENT_TURN_CAP,
    );
    if (activeTaskId) {
      await this.continueTask(ctx, chatId, activeTaskId, promptText);
      return;
    }
    // 5. Default: fork a new thread tagged with the explicit project
    //    (or null when no prefix). The bridge holds onto the prior
    //    thread for its own project — switching back later still
    //    finds it.
    await this.dispatchAsNewMessage(chatId, ctx, promptText, explicitProject);
  }

  /**
   * Parse a leading "alias: rest" project prefix when `alias` resolves
   * to a real project. Returns null when the message has no prefix or
   * the prefix doesn't match any project (treated as normal text).
   *
   * Loose grammar: `<alias>:` at the very start, alias = lowercase
   * letters / digits / dashes (matches the existing slug rules), then
   * a colon, then the rest of the message. Whitespace tolerated.
   */
  private extractProjectScope(
    text: string,
  ): { projectName: string; stripped: string } | null {
    const m = /^([a-z0-9-]+)\s*:\s*([\s\S]+)$/i.exec(text.trim());
    if (!m) return null;
    const alias = m[1]!;
    const rest = m[2]!.trim();
    if (!rest) return null;
    const project = this.ctx.resolveProject(alias);
    if (!project) return null;
    return { projectName: project.name, stripped: rest };
  }

  // ─── new-message routing (palette parity) ────────────────────────────

  private async dispatchAsNewMessage(
    chatId: number,
    ctx: Context,
    text: string,
    projectName: string | null = null,
  ): Promise<void> {
    let result;
    try {
      await ctx.sendChatAction('typing');
      result = await this.ctx.routePrompt(text, {
        origin: 'api',
        ...(projectName ? { projectName } : {}),
      });
    } catch (err) {
      await ctx.reply(`Couldn't route that: ${(err as Error).message}`);
      return;
    }
    if (result.kind === 'intent') {
      await ctx.reply(result.message ?? (result.ok ? 'Done.' : 'Intent failed.'));
      return;
    }
    if (result.kind === 'reminder') {
      const when = new Date(result.reminder.fireAt).toLocaleString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        day: 'numeric',
        month: 'short',
      });
      const verb = result.reminder.mode === 'scheduled' ? 'Scheduled' : 'Reminder set';
      await ctx.reply(`${verb} for ${when}: ${result.reminder.body}`);
      return;
    }
    // task → register with the project scope so future messages can
    // find this thread when the same scope is implied again, and wait
    // for first-turn result.
    this.bridge.register(result.task.id, chatId, projectName);
    await this.completeTurnAndReply(ctx, chatId, result.task.id);
  }

  private async continueTask(
    ctx: Context,
    chatId: number,
    taskId: string,
    text: string,
  ): Promise<void> {
    try {
      await ctx.sendChatAction('typing');
      await this.ctx.sendMessageToTask(taskId, text);
      // Bump TTL + turn count so the bridge knows this task is still
      // the active agent for this chat. Counts against the turn cap.
      this.bridge.recordTurn(taskId);
    } catch (err) {
      await ctx.reply(`Couldn't continue task: ${(err as Error).message}`);
      this.bridge.forget(taskId);
      return;
    }
    await this.completeTurnAndReply(ctx, chatId, taskId);
  }

  private async completeTurnAndReply(
    ctx: Context,
    chatId: number,
    taskId: string,
  ): Promise<void> {
    let turn;
    try {
      turn = await this.ctx.awaitTurnResult(taskId, { timeoutMs: REPLY_TIMEOUT_MS });
    } catch (err) {
      await ctx.reply(`Task ${taskId} didn't reply in time: ${(err as Error).message}`);
      this.bridge.forget(taskId);
      return;
    }
    const body = turn.finalText?.trim() || `Task ${turn.status}.`;
    if (turn.status === 'errored' || turn.status === 'aborted') {
      await this.sendChunked(ctx, chatId, `[task ${turn.status}] ${body}`);
      this.bridge.forget(taskId);
      return;
    }
    const lastMsg = await this.sendTurnResult(ctx, chatId, taskId, body, turn.awaitingInput);
    if (lastMsg) this.bridge.linkMessageToTask(lastMsg.message_id, taskId);
    // Persistent-agent semantics: don't drop the bridge on
    // !awaitingInput. The bridge's TTL + turn cap (see handleUserMessage
    // path 3) decides when to fork. This lets a user's next message
    // continue the same agent thread even after a turn closed cleanly.
    // Memory accumulation is bounded by TTL eviction on the next
    // message + the cap on simultaneous chat ids.
  }

  // ─── inline-button handlers ───────────────────────────────────────────

  private async handleApprove(ctx: ActionContext): Promise<void> {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== 'number' || !this.isAllowed(chatId)) {
      await safeAnswer(ctx);
      return;
    }
    const taskId = ctx.match[1];
    try {
      await this.ctx.sendMessageToTask(taskId, 'approved, go ahead');
      await safeAnswer(ctx, 'Approved');
      await this.completeTurnAndReply(ctx, chatId, taskId);
    } catch (err) {
      await safeAnswer(ctx, `Failed: ${(err as Error).message}`);
    }
  }

  private async handleCancel(ctx: ActionContext): Promise<void> {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== 'number' || !this.isAllowed(chatId)) {
      await safeAnswer(ctx);
      return;
    }
    const taskId = ctx.match[1];
    try {
      await this.ctx.abortTask(taskId);
      await safeAnswer(ctx, 'Cancelled');
      await ctx.reply(`Aborted task ${taskId}.`);
      this.bridge.forget(taskId);
    } catch (err) {
      await safeAnswer(ctx, `Failed: ${(err as Error).message}`);
    }
  }

  private async handleEdit(ctx: ActionContext): Promise<void> {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== 'number' || !this.isAllowed(chatId)) {
      await safeAnswer(ctx);
      return;
    }
    const taskId = ctx.match[1];
    this.editAwaiting.set(chatId, taskId);
    await safeAnswer(ctx, 'Reply with your edit');
    await ctx.reply('Send your follow-up as the next message; I’ll continue this task.');
  }

  private async handleReminderDone(ctx: ActionContext): Promise<void> {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== 'number' || !this.isAllowed(chatId)) {
      await safeAnswer(ctx);
      return;
    }
    const reminderId = ctx.match[1];
    const ok = this.ctx.markReminderDone(reminderId);
    await safeAnswer(ctx, ok ? 'Done' : 'Already done');
  }

  private async handleReminderSnooze(ctx: ActionContext): Promise<void> {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== 'number' || !this.isAllowed(chatId)) {
      await safeAnswer(ctx);
      return;
    }
    const reminderId = ctx.match[1];
    const durationKey = ctx.match[2];
    const ms = parseDuration(durationKey);
    if (ms === null) {
      await safeAnswer(ctx, 'Unknown duration');
      return;
    }
    const r = this.ctx.snoozeReminder(reminderId, ms);
    if (!r) {
      await safeAnswer(ctx, 'Reminder not found');
      return;
    }
    const when = new Date(r.fireAt).toLocaleString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      day: 'numeric',
      month: 'short',
    });
    await safeAnswer(ctx, `Snoozed → ${when}`);
  }

  // ─── outbound: notifier subscription ─────────────────────────────────

  private async handleNotification(e: NotificationEvent): Promise<void> {
    const target = this.livePrimaryChatId();

    switch (e.source) {
      case 'task-awaiting': {
        if (!e.taskId) return;
        // Bridged tasks (Telegram-originated, plus any task we already
        // adopted) reply through completeTurnAndReply — that path
        // already sends the agent's body with Approve/Edit/Cancel
        // buttons. Forwarding task-awaiting too would double-fire the
        // same ping. Skip.
        if (this.bridge.has(e.taskId)) return;
        if (!this.shouldForward('task-awaiting')) return;
        if (!target) return;
        // Adopt the task into the bridge so the user's reply continues
        // it via sendMessageToTask instead of starting a fresh thread.
        this.bridge.register(e.taskId, target);
        const taskId = e.taskId;
        const sent = await safeCall(() =>
          this.bot.telegram.sendMessage(target, `${e.title}\n${e.body}`, {
            reply_markup: {
              inline_keyboard: [[
                { text: 'Approve', callback_data: `approve:${taskId}` },
                { text: 'Edit…', callback_data: `edit:${taskId}` },
                { text: 'Cancel', callback_data: `cancel:${taskId}` },
              ]],
            },
          }),
        );
        if (sent && typeof sent.message_id === 'number') {
          this.bridge.linkMessageToTask(sent.message_id, taskId);
        }
        return;
      }
      case 'reminder':
      case 'scheduled-action': {
        if (!target) return;
        if (!this.shouldForward(e.source)) return;
        const buttons =
          e.source === 'reminder' && e.reminderId
            ? [
                { text: 'Done', callback_data: `rem_done:${e.reminderId}` },
                { text: 'Snooze 1h', callback_data: `rem_snooze:${e.reminderId}:1h` },
                { text: 'Snooze 1d', callback_data: `rem_snooze:${e.reminderId}:1d` },
              ]
            : null;
        await safeCall(() =>
          this.bot.telegram.sendMessage(target, `${e.title}\n${e.body}`, {
            ...(buttons ? { reply_markup: { inline_keyboard: [buttons] } } : {}),
          }),
        );
        return;
      }
      case 'task-complete':
      case 'task-errored': {
        if (!target || !e.taskId) return;
        // Bridged tasks: we already replied via completeTurnAndReply
        // when the turn ended; don't double-fire.
        if (this.bridge.has(e.taskId)) return;
        if (!this.shouldForward(e.source)) return;
        await safeCall(() =>
          this.bot.telegram.sendMessage(target, `${e.title}\n${e.body}`),
        );
        return;
      }
      case 'notify-tool':
      case 'meeting-heads-up':
      case 'inbox-new':
      case 'cost-guardrail': {
        if (!target) return;
        if (!this.shouldForward(e.source)) return;
        await safeCall(() =>
          this.bot.telegram.sendMessage(target, `${e.title}\n${e.body}`),
        );
        return;
      }
      case 'task-launched':
      case 'reminder-created':
      case 'skill-suggestion':
      case 'other':
      default:
        // Intentionally skipped — too noisy or already represented by
        // another event. Not exposed as a custom-topic toggle either.
        return;
    }
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  private isAllowed(chatId: number): boolean {
    return this.config.readLive().allowedChatIds.includes(chatId);
  }

  private liveNotifications(): 'all' | 'reminders' | 'custom' | 'off' {
    return this.config.readLive().notifications;
  }

  /**
   * Should this notification source be forwarded right now?
   * Ladder of decisions:
   *   1. notifications === 'off' → never forward (except things that
   *      use this.bridge — bridged conversations always reply).
   *   2. AFK widens the set: anything user might want to act on while
   *      away gets forwarded regardless of the toggle.
   *   3. notifications === 'all' → forward everything that has any
   *      forward path at all (the always-skipped sources still don't
   *      go through).
   *   4. notifications === 'custom' → consult the per-topic toggle.
   *   5. notifications === 'reminders' (the default) → preserve the
   *      historical "reminders + cockpit" envelope.
   *
   * Callers still gate on `bridged` / `taskId` / etc. as needed —
   * this function only decides on the source-level filter.
   */
  private shouldForward(source: NotificationSource): boolean {
    const live = this.config.readLive();
    if (live.notifications === 'off') return false;
    const afk = this.ctx.isAfk();
    if (live.notifications === 'all') return true;
    if (live.notifications === 'custom') {
      const t = live.customTopics;
      switch (source) {
        case 'reminder': return t.reminder;
        case 'scheduled-action': return t.scheduledAction;
        case 'task-awaiting': return t.taskAwaiting || afk;
        case 'cost-guardrail': return t.costGuardrail;
        case 'task-complete': return t.taskComplete || afk;
        case 'task-errored': return t.taskErrored || afk;
        case 'meeting-heads-up': return t.meetingHeadsUp;
        case 'inbox-new': return t.inboxNew;
        case 'notify-tool': return t.notifyTool || afk;
        default: return false;
      }
    }
    // 'reminders' (legacy default).
    switch (source) {
      case 'reminder':
      case 'scheduled-action':
      case 'task-awaiting':
      case 'cost-guardrail':
        return true;
      case 'task-complete':
      case 'task-errored':
      case 'meeting-heads-up':
      case 'inbox-new':
      case 'notify-tool':
        return afk;
      default:
        return false;
    }
  }

  private livePrimaryChatId(): number | null {
    return this.config.readLive().primaryChatId;
  }

  private async sendTurnResult(
    ctx: Context,
    _chatId: number,
    taskId: string,
    body: string,
    awaitingInput: boolean,
  ): Promise<Message.TextMessage | null> {
    const truncated = truncateForTelegram(body);
    const opts = awaitingInput
      ? {
          reply_markup: {
            inline_keyboard: [[
              { text: 'Approve', callback_data: `approve:${taskId}` },
              { text: 'Edit…', callback_data: `edit:${taskId}` },
              { text: 'Cancel', callback_data: `cancel:${taskId}` },
            ]],
          },
        }
      : {};
    return safeCall(() => ctx.reply(truncated, opts));
  }

  private async sendChunked(
    ctx: Context,
    _chatId: number,
    body: string,
  ): Promise<void> {
    const text = truncateForTelegram(body);
    await safeCall(() => ctx.reply(text));
  }
}

function parseDuration(key: string): number | null {
  const m = /^(\d+)([smhd])$/i.exec(key);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  switch (unit) {
    case 's': return n * 1_000;
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    case 'd': return n * 86_400_000;
    default: return null;
  }
}

function truncateForTelegram(s: string): string {
  if (s.length <= TELEGRAM_MESSAGE_LIMIT) return s;
  // Hard cap at the Telegram limit minus the footer so the message
  // always sends in one piece. Anything longer means "open Observatory
  // for the full reply" — chunking long-form transcripts is Phase 2.
  const footer = '\n\n…(truncated — see Observatory for the full reply)';
  const slice = s.slice(0, TELEGRAM_MESSAGE_LIMIT - footer.length);
  return `${slice}${footer}`;
}

async function safeCall<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.warn('[telegram-bot] telegram call failed:', err);
    return null;
  }
}

async function safeAnswer(ctx: ActionContext, text?: string): Promise<void> {
  try {
    await ctx.answerCbQuery(text);
  } catch {
    // answerCbQuery can fail if the callback already timed out
    // (Telegram allows ~14 days). Non-fatal.
  }
}
