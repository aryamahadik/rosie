// The clock home, S13-35 "Runs every clock from the visit", as code (T-591; C-055; S13-35, S13-02, S13-03; RULES 4.3,
// 5.1 to 5.5, 5.8). Every journey step that follows the clock home calls this module and never rewrites its rules
// (build prompt 3.5; section 10: "Wrong: each journey lane writing its own STOP, money-line or clock logic"):
//
//   - Deadlines (./deadline.ts): every due time ends by the visit and sits inside the person's text hours in the zone it
//     is set in (CQ-05: the visit's, else the business's), leaving time to act; on a job sent now it is the plug-in's
//     urgent clock, any hour. `homeDueOf` holds step 9's due rule (../due.ts dueOf, T-255) to the home and
//     `homeNeverDeliveredDueOf` its never-delivered path; `fitDeadline` holds any other deadline; `urgentDue` is the
//     urgent clock.
//   - Text hours (./text-hours.ts): 9am to 8pm, the owner's and team's from 8am, 8pm the last minute; `textHoursAfter`
//     adds N text hours ("2 of their text hours").
//   - Reminders (./reminder.ts): one per booked time, keyed by the booking and the start, at least 3 hours before free
//     cancel ends: usually 10am the day before, 6pm the evening before that when free cancel ends before 1pm the day
//     before; none for a job sent now or a booking made after the reminder's time.
//   - Zones (./shown.ts): a deadline shows the person's own time too when their zone's clock reads otherwise.
//   - The registry's module (./module.ts): the clock home's points and rulings for the home registry (T-586).
//
// Pure functions: no database, no network, no clock of their own. The clock rows they time are armed and fired through
// K-05 and the actors' alarms (../arming.ts, ../actor-clocks.ts; T-254, T-255).

export {
  fitDeadline,
  homeDueOf,
  homeNeverDeliveredDueOf,
  urgentDue,
  type DeadlineInput,
  type HomeDeadline,
  type HomeDue,
  type HomeDueInput,
  type HomeFit,
  type HomeNeverDeliveredDue,
  type HomeNeverDeliveredInput,
  type UrgentInput,
} from "./deadline";
export { CLOCK_HOME_POINTS, clockHomeModule, type ClockHomeModule, type ClockHomePoint } from "./module";
export {
  REMINDER_EVENING_HOUR,
  REMINDER_HOUR,
  REMINDER_LEAD_MS,
  reminderKeyOf,
  reminderOf,
  remindersOf,
  type BookedTime,
  type NoReminder,
  type Reminder,
  type ReminderInput,
  type ReminderRequest,
  type ReminderRule,
} from "./reminder";
export { shownTimes, wallTimeOf, type ShownInput, type WallTime } from "./shown";
export {
  CLOSES_HOUR,
  CUSTOMER_OPENS_HOUR,
  inTextHours,
  lastInTextHours,
  nextInTextHours,
  opensHourOf,
  TEAM_OPENS_HOUR,
  textHoursAfter,
  type Audience,
} from "./text-hours";
