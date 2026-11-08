// The clock home as the home registry holds it (T-591; T-586's handoff: "each registers a HomeModule {home, points,
// rule(point, context) -> label} through createHomeRegistry({flows, modules}); the clock module comes from the runtime
// side (T-591)"; actions/src/homes/registry homes.ts: clock -> runtime/src/clocks/home, via the due rule).
//
// S13-30: a step that follows the clock home and says otherwise on one of these points gets the home's ruling, logged by
// the registry. The points and rulings are labels, never words (arch 02 line 139):
//   clockEndsBy       visitStart     no clock runs past the visit (S13-35; RULES 5.1);
//   clockHours        textHours      deadlines sit inside text hours (S13-35; RULES 4.3, 5.1), or
//                     urgentAnyHour  on a job sent now, the plug-in's urgent clock, any hour (S13-35; RULES 5.5);
//   remindersPerTime  one            one reminder for each booked time, never two (S13-35; RULES 5.4), or
//                     none           on a job sent now (B7-55);
//   deadlineZones     theirsToo      a deadline sent across zones shows the person's time too (S13-03; RULES 5.2).
// The times themselves come from ./deadline.ts and ./reminder.ts. The context is read for one fact, `sentNow` (true for a
// booking sent now); anything else counts as a set time.

/** The points the clock home settles (unique across the ten homes: the registry refuses a point in two). */
export const CLOCK_HOME_POINTS = ["clockEndsBy", "clockHours", "remindersPerTime", "deadlineZones"] as const;

export type ClockHomePoint = (typeof CLOCK_HOME_POINTS)[number];

/** The registry's HomeModule shape (actions/src/homes/registry registry.ts), for the clock home: any context will do. */
export interface ClockHomeModule {
  readonly home: "clock";
  readonly points: readonly ClockHomePoint[];
  rule(point: string, context: unknown): string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** True when the context says the booking was sent now. */
const sentNowIn = (context: unknown): boolean => isRecord(context) && context.sentNow === true;

export const clockHomeModule: ClockHomeModule = {
  home: "clock",
  points: CLOCK_HOME_POINTS,
  rule(point, context) {
    switch (point) {
      case "clockEndsBy":
        return "visitStart";
      case "clockHours":
        return sentNowIn(context) ? "urgentAnyHour" : "textHours";
      case "remindersPerTime":
        return sentNowIn(context) ? "none" : "one";
      case "deadlineZones":
        return "theirsToo";
      default:
        throw new Error("the clock home settles no such point");
    }
  },
};
