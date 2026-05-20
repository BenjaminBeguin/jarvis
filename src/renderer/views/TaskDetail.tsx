import type { TaskSummary } from '../../shared/types';
import { Conversation } from './conversation/Conversation';

interface Props {
  task: TaskSummary;
  /** Lets reply paths swap to a freshly-created task (e.g. fork
   *  resume from an external Claude Code session). */
  onSelectTask?: (id: string) => void;
}

/**
 * Thin wrapper around the unified <Conversation> renderer. Kept for
 * backwards compatibility with the Observatory's TaskDetail import
 * and to lock in `mode='full'` (system events visible by default).
 */
export function TaskDetail({ task, onSelectTask }: Props) {
  return (
    <Conversation
      taskId={task.id}
      mode="full"
      onSelectTask={onSelectTask}
    />
  );
}
