// T-512: what a link's page may show, from openLink's answer (view.ts). Proof of a person comes only from a session of
// the link's own person that came with the request, never from the link (FS line 701; S13-45; K-21 v1
// refuse-link-as-proof.json); the view never holds whom the call acts for; and every page kind and section K-21 v1
// holds has its words (kinds.ts). The answers are K-21 v1's own fixtures, or one field of them changed (rule 9).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPageError, type ResponseOf } from "../client/calls";
import { PAGE_KIND_WORDS, SECTION_WORDS, type PageKind, type PageSection } from "./kinds";
import { openLinkFixture, type OpenLinkExchange } from "./test-support";
import { LinkViewError, linkViewOf } from "./view";

/** A fixture's answer that opens a page. */
function opened(fixture: OpenLinkExchange): ResponseOf<"openLink"> {
  if (isPageError(fixture.outcome)) throw new Error("this fixture's answer does not open a page");
  return fixture.outcome;
}

const SECURE = opened(openLinkFixture("open-link-secure-page.json"));
const SIGNED_IN = opened(openLinkFixture("open-link-signed-in.json"));
const AS_PROOF = opened(openLinkFixture("invalid/refuse-link-as-proof.json"));

const VIEW_KEYS = ["pageKind", "stepId", "businessName", "sections", "proven", "securePageOnly", "expiresAt"];

describe("linkViewOf: a person is proven only by a session of the link's own person, never by the link", () => {
  it("open-link-secure-page.json, no session sent: not proven, no secure-page-only fields, no time", () => {
    expect(linkViewOf(SECURE, false)).toEqual({
      pageKind: "setupIdCheck",
      stepId: "S1-10",
      businessName: "Lee's Barbershop",
      sections: ["idUpload", "ownerEmail"],
      proven: false,
      securePageOnly: false,
      expiresAt: null,
    });
  });

  it("open-link-signed-in.json, the session sent: proven, with its secure-page-only fields and the link's end", () => {
    expect(linkViewOf(SIGNED_IN, true)).toEqual({
      pageKind: "staffPage",
      stepId: "S2-06",
      businessName: "Lee's Barbershop",
      sections: ["profile", "license", "calendar", "emergencyContact"],
      proven: true,
      securePageOnly: true,
      expiresAt: "2026-10-27T15:00:00Z",
    });
  });

  it("refuse-link-as-proof.json's answer, to a request that sent no session: never proven, shown as open-link-secure-page.json's", () => {
    expect(AS_PROOF.proof).toBe("session");
    expect(AS_PROOF.securePageOnly).toBe(true);
    expect(linkViewOf(AS_PROOF, false)).toEqual(linkViewOf(SECURE, false));
  });

  it("the same answer counts once a session came with the request, as K-21 accepts it with one (open-link-signed-in.json's case)", () => {
    expect(linkViewOf(AS_PROOF, true)).toMatchObject({ proven: true, securePageOnly: true });
  });

  it("proof none never counts, whether or not a session was sent", () => {
    for (const sent of [false, true])
      expect(linkViewOf(SECURE, sent)).toMatchObject({
        proven: false,
        securePageOnly: false,
        expiresAt: null,
      });
  });

  it("proof session with no one the call acts for never counts", () => {
    expect(linkViewOf({ ...SIGNED_IN, acting: null }, true)).toMatchObject({
      proven: false,
      securePageOnly: false,
      expiresAt: null,
    });
  });

  it("never holds whom the call acts for, the answer's proof or its sign-in ways", () => {
    for (const [open, sent] of [
      [SECURE, false],
      [SIGNED_IN, true],
      [AS_PROOF, false],
      [AS_PROOF, true],
    ] as const) {
      const view = linkViewOf(open, sent);
      expect(Object.keys(view)).toEqual(VIEW_KEYS);
      expect(JSON.stringify(view)).not.toContain("person-");
    }
  });

  it("leaves out a section K-21 v1 does not hold, and refuses a page kind it does not hold", () => {
    const sections = [...SECURE.sections, "dummySection" as PageSection];
    expect(linkViewOf({ ...SECURE, sections }, false).sections).toEqual(["idUpload", "ownerEmail"]);
    expect(() => linkViewOf({ ...SECURE, pageKind: "dummyKind" as PageKind }, false)).toThrow(LinkViewError);
    expect(() => linkViewOf({ ...SECURE, pageKind: "constructor" as PageKind }, false)).toThrow(
      LinkViewError,
    );
  });
});

describe("every page kind and section K-21 v1 holds has its words", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../../../contracts/page-api/page-api.v1.schema.json", import.meta.url), "utf8"),
  ) as { $defs: { pageKind: { enum: string[] }; pageSection: { enum: string[] } } };

  it("page kinds: exactly K-21 v1 pageKind's", () => {
    expect(Object.keys(PAGE_KIND_WORDS).sort()).toEqual([...schema.$defs.pageKind.enum].sort());
  });

  it("sections: exactly K-21 v1 pageSection's", () => {
    expect(Object.keys(SECTION_WORDS).sort()).toEqual([...schema.$defs.pageSection.enum].sort());
  });
});
