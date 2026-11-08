// The kind table (../kinds.ts, T-323): every K-07 v1 effect kind, the port K-07 ties it to, and the port contract's call
// its span names; which ports a runner serves; the provider a span names.

import { describe, expect, it } from "vitest";

import {
  EFFECT_KINDS,
  EFFECT_PORTS,
  isEffectKind,
  kindsOf,
  providerOf,
  servedPorts,
  type EffectKind,
  type EffectPortName,
  type EffectRow,
  type KindPort,
} from "../kinds";
import { calendarWrite, contactAdd, contractChecks, depositCharge, readContractJson } from "./test-support";

const k07 = readContractJson("outbox-effects/outbox-effects.v1.schema.json") as {
  $defs: { effectKind: { enum: string[] } };
};

/** A valid K-07 v1 effect row of each port, from K-05's and K-07's fixtures. */
const rowOf: Record<EffectPortName, () => EffectRow> = {
  stripe: depositCharge,
  calendar: calendarWrite,
  linq: contactAdd,
};

/** The frozen port contract each port's calls are named in (K-14, K-16, K-11). */
const portContract: Record<EffectPortName, string> = {
  stripe: "port-stripe/port-stripe.v1.schema.json",
  calendar: "port-calendar/port-calendar.v1.schema.json",
  linq: "port-linq/port-linq.v1.schema.json",
};

const port: KindPort = {
  run: () => Promise.resolve({ outcome: "ok", providerObjectId: null, ledgerLineId: null }),
};

describe("effect kinds (K-07 v1)", () => {
  it("lists exactly K-07 v1's effect kinds", () => {
    expect(Object.keys(EFFECT_KINDS).sort()).toEqual([...k07.$defs.effectKind.enum].sort());
    for (const kind of k07.$defs.effectKind.enum) expect(isEffectKind(kind)).toBe(true);
    for (const other of ["calendar_fax", "toString", "", null, 7]) expect(isEffectKind(other)).toBe(false);
  });

  it("ties each kind to the port K-07 v1's effectRow accepts it with, and refuses it on any other", () => {
    for (const [kind, info] of Object.entries(EFFECT_KINDS) as [
      EffectKind,
      (typeof EFFECT_KINDS)[EffectKind],
    ][]) {
      const row: EffectRow = { ...rowOf[info.port](), kind, port: info.port };
      expect(contractChecks().k07("effectRow", row), kind).toEqual([]);
      for (const other of EFFECT_PORTS.filter((each) => each !== info.port)) {
        expect(contractChecks().k07("effectRow", { ...row, port: other }), `${kind} on ${other}`).not.toEqual(
          [],
        );
      }
    }
  });

  it("names each kind's call as its port contract does", () => {
    for (const info of Object.values(EFFECT_KINDS)) {
      const contract = readContractJson(portContract[info.port]) as { $defs: Record<string, unknown> };
      expect(Object.hasOwn(contract.$defs, `${info.call}.request`), info.call).toBe(true);
    }
    expect(EFFECT_KINDS.rosfield_monthly_charge.call).toBe("charge");
    expect(EFFECT_KINDS.calendar_update.call).toBe("calendarUpdate");
    expect(EFFECT_KINDS.linq_contact_add.call).toBe("contactAdd");
  });

  it("serves a port only when every one of its kinds has a port", () => {
    expect(servedPorts({})).toEqual([]);
    const calendar = Object.fromEntries(kindsOf("calendar").map((kind) => [kind, port]));
    expect(servedPorts(calendar)).toEqual(["calendar"]);
    expect(servedPorts({ ...calendar, stripe_charge: port, stripe_refund: port })).toEqual(["calendar"]);
    const every = Object.fromEntries(Object.keys(EFFECT_KINDS).map((kind) => [kind, port]));
    expect(servedPorts(every)).toEqual(["stripe", "calendar", "linq"]);
    expect(kindsOf("stripe")).toHaveLength(6);
    expect(kindsOf("linq")).toEqual(["linq_contact_add"]);
  });

  it("names the span's provider from the port, and a calendar's own, or none for a calendar that names none", () => {
    expect(providerOf({ port: "stripe", calendarProvider: null })).toBe("stripe");
    expect(providerOf({ port: "linq", calendarProvider: null })).toBe("linq");
    expect(providerOf({ port: "calendar", calendarProvider: "google" })).toBe("google_calendar");
    expect(providerOf({ port: "calendar", calendarProvider: "microsoft" })).toBe("microsoft_calendar");
    expect(providerOf({ port: "calendar", calendarProvider: null })).toBeNull();
  });
});
