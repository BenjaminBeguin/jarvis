import type { AppStatus } from '@shared/types';

import type { InboxStore } from '../inbox.js';
import type { McpConfigStore } from '../mcp-config.js';
import type { ModuleRegistry } from '../module-registry.js';
import type { PreferencesStore } from '../preferences-store.js';
import type { ProjectMemoryStore } from '../project-memory.js';
import type { ProjectStore } from '../projects.js';
import type { ReminderStore } from '../reminders.js';
import type { RoutineStore } from '../routines.js';
import type { ShellRunner } from '../shell-runner.js';
import type { SkillStore } from '../skill-store.js';
import type { SkillSuggestionStore } from '../skill-suggestions.js';
import type { TaskRunner } from '../task-runner.js';
import type { UserContextStore } from '../user-context.js';

/**
 * Dependency bag passed into every per-domain IPC registrar. Each file
 * destructures the slice it needs.
 *
 * If/when we move Jarvis to a server-mode runtime, these stores stay put —
 * the registrar files become route handlers, the deps stay identical.
 */
export interface IpcDeps {
  skills: SkillStore;
  mcp: McpConfigStore;
  projects: ProjectStore;
  projectMemory: ProjectMemoryStore;
  modules: ModuleRegistry;
  runner: TaskRunner;
  shellRunner: ShellRunner;
  routines: RoutineStore;
  reminders: ReminderStore;
  skillSuggestions: SkillSuggestionStore;
  userContext: UserContextStore;
  preferences: PreferencesStore;
  inbox: InboxStore;
  jarvisRoot: string;
  auth: {
    /** Reconcile auth state from disk + keychain; returns the next status. */
    refresh(): Promise<AppStatus>;
    /** refresh + broadcast appStatus to all renderers. */
    broadcastStatus(): Promise<AppStatus>;
    /** Latest claude CLI binary path detected by refresh(). */
    currentBinaryPath(): string | null;
  };
  hud: {
    /** Pop the Answer HUD and track this task id. */
    pushTask(taskId: string): void;
  };
}
