// T-1533's unit proof of the face's hold of S1-10's secure link (held.ts HeldLinks; K-09 README default 211; DL-1167
// (3)): staged by turn and outbox row id, replaced at the same row id, held only for the rows a fresh commit lists, let go
// once the row's finalize answered, and bounded as the texts are. `npm run test:unit -- actions/src/tool-api/turn-face`.
// The links are made-up 32-hex codes under staging's place; none is a real link.

import { describe, expect, it } from "vitest";

import { HeldLinks, MAX_HELD } from "./held";

const linkOf = (n: number): string => `https://rosfield.com/test/${n.toString(16).padStart(32, "0")}`;

describe("HeldLinks: S1-10's secure link between the commit and its row's finalize", () => {
  it("a staged link is held only once kept for a row the commit lists, and read back by that row's id", () => {
    const links = new HeldLinks();
    links.stage("turn-1", "outbox-s1-10-turn-1-1", linkOf(1));
    expect(links.of("outbox-s1-10-turn-1-1")).toBeNull();
    links.keep("turn-1", ["outbox-s1-09-turn-1-1", "outbox-s1-10-turn-1-1"]);
    expect(links.of("outbox-s1-10-turn-1-1")).toBe(linkOf(1));
    expect(links.size).toBe(1);
    expect(links.stagedTurns).toBe(0);
  });

  it("a later gate run's link replaces the earlier one at the same row id: the last staged is the one held", () => {
    const links = new HeldLinks();
    links.stage("turn-1", "outbox-s1-10-turn-1-1", linkOf(1));
    links.stage("turn-1", "outbox-s1-10-turn-1-1", linkOf(2));
    links.keep("turn-1", ["outbox-s1-10-turn-1-1"]);
    expect(links.of("outbox-s1-10-turn-1-1")).toBe(linkOf(2));
  });

  it("a staged link whose row the commit does not list is dropped, never held", () => {
    const links = new HeldLinks();
    links.stage("turn-1", "outbox-s1-10-turn-1-1", linkOf(1));
    links.keep("turn-1", ["outbox-s1-09-turn-1-1"]);
    expect(links.of("outbox-s1-10-turn-1-1")).toBeNull();
    expect(links.size).toBe(0);
    expect(links.stagedTurns).toBe(0);
  });

  it("dropStaged drops the turn's staged links alone; another turn's stay staged, and what is held stays held", () => {
    const links = new HeldLinks();
    links.stage("turn-0", "outbox-s1-10-turn-0-1", linkOf(0));
    links.keep("turn-0", ["outbox-s1-10-turn-0-1"]);
    links.stage("turn-1", "outbox-s1-10-turn-1-1", linkOf(1));
    links.stage("turn-2", "outbox-s1-10-turn-2-1", linkOf(2));
    links.dropStaged("turn-1");
    links.keep("turn-1", ["outbox-s1-10-turn-1-1"]);
    links.keep("turn-2", ["outbox-s1-10-turn-2-1"]);
    expect(links.of("outbox-s1-10-turn-1-1")).toBeNull();
    expect(links.of("outbox-s1-10-turn-2-1")).toBe(linkOf(2));
    expect(links.of("outbox-s1-10-turn-0-1")).toBe(linkOf(0));
  });

  it("letGo lets the row's link go; another row's stays", () => {
    const links = new HeldLinks();
    links.stage("turn-1", "outbox-s1-10-turn-1-1", linkOf(1));
    links.stage("turn-2", "outbox-s1-10-turn-2-1", linkOf(2));
    links.keep("turn-1", ["outbox-s1-10-turn-1-1"]);
    links.keep("turn-2", ["outbox-s1-10-turn-2-1"]);
    links.letGo("outbox-s1-10-turn-1-1");
    expect(links.of("outbox-s1-10-turn-1-1")).toBeNull();
    expect(links.of("outbox-s1-10-turn-2-1")).toBe(linkOf(2));
  });

  it("is bounded as the texts are: the newest MAX_HELD links held and turns staged, the oldest going first", () => {
    const links = new HeldLinks();
    for (let n = 0; n <= MAX_HELD; n += 1) {
      links.stage(`turn-${String(n)}`, `outbox-${String(n)}`, linkOf(n));
    }
    expect(links.stagedTurns).toBe(MAX_HELD);
    for (let n = 0; n <= MAX_HELD; n += 1) links.keep(`turn-${String(n)}`, [`outbox-${String(n)}`]);
    expect(links.size).toBe(MAX_HELD);
    expect(links.of("outbox-0")).toBeNull();
    expect(links.of(`outbox-${String(MAX_HELD)}`)).toBe(linkOf(MAX_HELD));
    const small = new HeldLinks(2);
    for (const n of [1, 2, 3]) {
      small.stage("turn", `outbox-${String(n)}`, linkOf(n));
    }
    small.keep("turn", ["outbox-1", "outbox-2", "outbox-3"]);
    expect([small.of("outbox-1"), small.of("outbox-2"), small.of("outbox-3")]).toEqual([
      null,
      linkOf(2),
      linkOf(3),
    ]);
  });
});
