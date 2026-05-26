export { failedRoutinesInboxSource } from './failed-routines.js';
export {
  prAddressCommentsInboxSource,
  prReviewQueueInboxSource,
} from './gh.js';
export { goalsInboxSource } from './goals.js';
// Linear / Slack / Calendar inbox sources retired in favour of workflows
// (electron/main/seeds/workflows/{linear-inbox,slack-inbox,calendar-today}.ts).
// Each workflow's inbox-write node feeds InboxStore.setExternalItems().
export { remindersInboxSource } from './reminders.js';
export { userInboxSource } from './user.js';
