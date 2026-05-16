import type { Module, ModuleContext } from '../types.js';
import { loadModuleSettings } from '../../auth.js';
import { getTelegramBotToken } from '../../secrets.js';

import { TelegramBot, type TelegramBotConfig } from './bot.js';

const MODULE_ID = 'telegram-bot';

let runningBot: TelegramBot | null = null;

function parseAllowedChatIds(raw: string): number[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n));
}

function readConfig(): {
  allowedChatIds: number[];
  primaryChatId: number | null;
  notifications: 'all' | 'reminders' | 'custom' | 'off';
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
} {
  const settings = loadModuleSettings(MODULE_ID);
  const allowedChatIds = parseAllowedChatIds(
    typeof settings['allowedChatIds'] === 'string'
      ? (settings['allowedChatIds'] as string)
      : '',
  );
  const rawN = settings['notifications'];
  const notifications =
    rawN === 'all' || rawN === 'reminders' || rawN === 'custom' || rawN === 'off'
      ? rawN
      : 'reminders';
  const bool = (key: string, dflt: boolean): boolean => {
    const v = settings[key];
    return typeof v === 'boolean' ? v : dflt;
  };
  return {
    allowedChatIds,
    primaryChatId: allowedChatIds[0] ?? null,
    notifications,
    customTopics: {
      reminder: bool('notif.reminder', true),
      scheduledAction: bool('notif.scheduledAction', true),
      taskAwaiting: bool('notif.taskAwaiting', true),
      costGuardrail: bool('notif.costGuardrail', true),
      taskComplete: bool('notif.taskComplete', false),
      taskErrored: bool('notif.taskErrored', true),
      meetingHeadsUp: bool('notif.meetingHeadsUp', false),
      inboxNew: bool('notif.inboxNew', false),
      notifyTool: bool('notif.notifyTool', false),
    },
  };
}

async function startBot(ctx: ModuleContext): Promise<void> {
  if (runningBot) return;
  const token = await getTelegramBotToken();
  if (!token) {
    console.log(
      `[${MODULE_ID}] no bot token in Keychain; skipping launch. Set it from Settings → Modules → Telegram bot.`,
    );
    return;
  }
  const initial = readConfig();
  if (initial.allowedChatIds.length === 0) {
    console.log(
      `[${MODULE_ID}] no allowed chat ids configured; bot will only respond to /start.`,
    );
  }
  const bot = new TelegramBot(ctx, {
    token,
    // readLive reruns on every read so allowlist/notifications changes
    // in the Settings panel take effect without a module reload.
    readLive: () => readConfig(),
  });
  try {
    await bot.launch();
    runningBot = bot;
    console.log(`[${MODULE_ID}] bot launched (long-polling).`);
  } catch (err) {
    console.error(`[${MODULE_ID}] launch failed:`, err);
    throw err;
  }
}

async function stopBot(): Promise<void> {
  if (!runningBot) return;
  await runningBot.stop();
  runningBot = null;
}

export const telegramBotModule: Module = {
  id: MODULE_ID,
  name: 'Telegram bot',
  description:
    'Pilot Jarvis from your phone via a Telegram bot. Trigger skills, get reminders + awaiting-input prompts with [Approve]/[Edit]/[Cancel] buttons, continue tasks by replying.',
  version: '1.0.0',

  settings: {
    description: [
      'Pilot Jarvis from your phone via a Telegram bot. One-time setup (~5 minutes).',
      '',
      'PART A — Create the bot:',
      '',
      '1. Open Telegram, search for @BotFather (the verified blue-check account).',
      '2. Send /newbot — answer the two prompts:',
      '   • display name (anything, e.g. "My Jarvis")',
      '   • username ending in "bot" (e.g. jarvis_<yourname>_bot)',
      '3. BotFather replies with an HTTP API token like 123456:ABC-DEF…',
      '4. Click "Set token" below, paste it, Save. The bot starts immediately.',
      '',
      'PART B — Get your chat ID (no group needed):',
      '',
      'A "chat ID" is just your personal Telegram user ID seen by the bot. It is NOT a channel or a group — for personal use you talk to the bot 1:1.',
      '',
      '5. In Telegram\'s search bar, type the bot\'s @username from step 2 and tap it. A fresh chat opens, like with a friend.',
      '6. Tap the big blue "Start" button at the bottom (or send /start).',
      '7. The bot replies with "Your chat id is 123456789".',
      '8. Paste that number into "Allowed chat IDs" below.',
      '',
      '(Shared use? Add the bot to a Telegram group instead, /start in the group — the chat ID will be negative, e.g. -100123… Paste that. Skip if it\'s just you.)',
      '',
      'Now text or voice-note your bot. Reply to a bot message to continue the same task. Tap [Approve] / [Edit] / [Cancel] when a task asks for confirmation. Toggle AFK (top-right phone icon or tray menu) to widen what mirrors to your phone.',
    ].join('\n'),
    fields: [
      {
        key: 'botToken',
        type: 'secret',
        label: 'Bot token',
        hint:
          'From @BotFather. Stored in macOS Keychain; never written to disk in plaintext.',
        default: '',
      },
      {
        key: 'allowedChatIds',
        type: 'text',
        label: 'Allowed chat IDs',
        hint:
          'Comma-separated Telegram chat IDs that can talk to the bot. Use /start in Telegram to discover yours.',
        default: '',
      },
      {
        key: 'notifications',
        type: 'select',
        label: 'Send to phone — overall',
        hint:
          'Top-level switch. "Custom" lets you pick per topic below. AFK widens the set regardless.',
        options: [
          { value: 'all', label: 'All notifications' },
          {
            value: 'reminders',
            label: 'Reminders + cockpit only (default)',
          },
          { value: 'custom', label: 'Custom (use per-topic toggles below)' },
          { value: 'off', label: 'Nothing (inbound only)' },
        ],
        default: 'reminders',
      },
      // Per-source toggles. Only consulted when notifications === 'custom'.
      // Order matches mental priority — "things you might miss without
      // your phone" at the top, "ambient" at the bottom.
      {
        key: 'notif.reminder',
        type: 'boolean',
        label: '  · Reminders firing',
        hint: 'A reminder you set hit its fire time.',
        default: true,
      },
      {
        key: 'notif.scheduledAction',
        type: 'boolean',
        label: '  · Scheduled actions firing',
        hint: '"In 2h, send …" kicked off a Claude turn.',
        default: true,
      },
      {
        key: 'notif.taskAwaiting',
        type: 'boolean',
        label: '  · Agent asks for your input',
        hint:
          'A running task transitioned to awaiting-reply. Phone-tap completes the turn from anywhere.',
        default: true,
      },
      {
        key: 'notif.costGuardrail',
        type: 'boolean',
        label: '  · Cost guardrail crossed',
        hint: 'A task spent past the warning threshold ($0.50).',
        default: true,
      },
      {
        key: 'notif.taskComplete',
        type: 'boolean',
        label: '  · Task completed',
        hint: 'A non-bridged task finished. Bridged ones (started from Telegram) always reply.',
        default: false,
      },
      {
        key: 'notif.taskErrored',
        type: 'boolean',
        label: '  · Task errored',
        hint: 'A non-bridged task failed.',
        default: true,
      },
      {
        key: 'notif.meetingHeadsUp',
        type: 'boolean',
        label: '  · Meeting starting soon',
        hint: 'Calendar item is < 5 min away.',
        default: false,
      },
      {
        key: 'notif.inboxNew',
        type: 'boolean',
        label: '  · New inbox items',
        hint: 'Inbox refresh found something new.',
        default: false,
      },
      {
        key: 'notif.notifyTool',
        type: 'boolean',
        label: '  · Agent notify() calls',
        hint:
          'Any Claude task that calls mcp__jarvis__notify. Noisy if you have many ambient skills.',
        default: false,
      },
    ],
  },

  async onLoad(ctx) {
    try {
      await startBot(ctx);
    } catch (err) {
      // Don't block module registration on a transient Telegram outage —
      // log and stay enabled. The user can restart the app or toggle the
      // module off/on to retry. A bad token still throws synchronously
      // inside startBot via bot.telegram.getMe().
      console.warn(`[${MODULE_ID}] onLoad failed:`, err);
    }
  },

  async onUnload() {
    await stopBot();
  },
};
