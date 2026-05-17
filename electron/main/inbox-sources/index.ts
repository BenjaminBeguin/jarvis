export { calendarInboxSource } from './calendar.js';
export { failedRoutinesInboxSource } from './failed-routines.js';
export {
  prAddressCommentsInboxSource,
  prReviewQueueInboxSource,
} from './gh.js';
// Linear inbox source retired in favour of the linear-inbox-sync
// workflow (electron/main/seeds/workflows/linear-inbox.ts). The
// workflow's inbox-write node feeds InboxStore.setExternalItems().
export { remindersInboxSource } from './reminders.js';
export { slackInboxSource } from './slack.js';
export { userInboxSource } from './user.js';
