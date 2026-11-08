// Times as the per-turn part shows them. K-02 gives every time as an instant in UTC with the IANA zone it is read in
// (CQ-09; S13-03). The model reads each in its own zone, with the weekday and the UTC offset, so "thursday afternoon"
// reads from the day the text was sent (arch 06 line 309, limit 6: dates resolve from the send time; code re-parses
// every value from its words).

import { ContextRefusedError } from "./errors";
import type { ContextTime } from "./types";

/** The shared `utc` format (contracts/common/formats.v1.schema.json). */
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$/u;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant of a time, in epoch milliseconds. `what` names the time in the refusal, never its value. */
export function instantOf(time: ContextTime, what: string): number {
  const at = UTC.test(time.utc) ? Date.parse(time.utc) : Number.NaN;
  if (Number.isNaN(at)) throw new ContextRefusedError(`${what} is not an instant in UTC (CQ-09)`);
  return at;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function formatIn(zone: string, what: string): Intl.DateTimeFormat {
  let format = formats.get(zone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZoneName: "longOffset",
      });
    } catch {
      throw new ContextRefusedError(`${what} is in a zone that is not an IANA time zone (CQ-09)`);
    }
    formats.set(zone, format);
  }
  return format;
}

/** A time as the model reads it: "Mon 2026-10-19 10:05 GMT-04:00 America/New_York". */
export function timeLabel(time: ContextTime, what: string): string {
  const at = instantOf(time, what);
  const parts = new Map(
    formatIn(time.zone, what)
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.get(type) ?? "";
  return `${part("weekday")} ${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} ${part("timeZoneName")} ${time.zone}`;
}
