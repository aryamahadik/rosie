// C10 (Master Corrections section 3 and section 8 "ID check"; RULES 9.5, 10.4; FRONTEND-SPEC row B14): the owner's ID
// is an upload, accepted as given.
//
// The master proves the owner with a secure ID check: a selfie matched to the license photo, or a person on Rosie's
// team on a video call (S1-10), and the go-live gate S1-32 waits for it, with a branch for an ID that doesn't match
// (S1-52). What holds: the owner uploads a photo or file of an ID document on the secure page, never in the chat. Any
// document is accepted as given, with no check, and that counts as "the ID confirmed" wherever the master, C4 or C8 asks
// for it. No face match or video check runs. An ID-check service is added later behind a switch that stays off until
// Jay turns it on. The control half of S1-32 is unchanged. Uploads stay private in R2.
//
// What this file changes (the card's steps): S1-10's ID lines, words and form; S1-32's line for "The ID doesn't match"
// and that branch, switched off so no path reaches S1-52; and S1-77's words for the owner's own ID check. S1-10 still
// gives `id_checked`, which the upload now stands for. C9 (run before this) changes S1-10's phone code.
import type { Correction, EditContext, LineRule } from "./framework";

type Obj = Record<string, unknown>;
type Line = readonly unknown[];

/** Why the branch for an ID that doesn't match is switched off, as an `off` op's `why`. */
export const ID_ACCEPTED_OFF =
  "the owner's ID is an upload accepted as given, so it never fails to match (MC C10)";

/** A line about a face match, a selfie, face data or a video check: none runs (C10). */
export const FACE_OR_VIDEO = /\bface\b|\bselfie\b|\bvideo\b|checks your ID instead/i;

/** S1-10's new lines, where its face match and video lines were. */
export const ID_UPLOAD_LINES: readonly string[] = [
  "The owner uploads a photo or file of an ID document on the secure page. Any document is accepted as given, with no check.",
  "An ID-check service comes later, behind a switch that stays off for now.",
];

/** The card line and form field S1-10's secure page gets. */
export const ID_UPLOAD_CARD_LINE = "Upload a photo or file of your ID";
export const ID_UPLOAD_FIELD = "ID photo or file";

const S1_10_LINES: readonly LineRule[] = [
  [/The ID check proves the person\./, "Their ID is an upload on the secure page, accepted as given."],
  [
    /^Safe default: not checked, and nothing goes live\. A person checks by video if asked\.$/,
    "Safe default: no ID uploaded yet, and nothing goes live.",
  ],
  [/Your secure ID check is below\./, "Your secure ID upload is below."],
  ["Secure ID check", "Secure ID upload"],
];

const S1_32_LINES: readonly LineRule[] = [
  [
    /^Means 'The ID doesn't match':.*$/,
    "The ID is the owner's upload, accepted as given, so it never fails to match.",
  ],
];

const S1_77_LINES: readonly LineRule[] = [
  [/their own ID check/, "their own ID upload"],
  [/Check your ID and confirm here\./, "Upload your ID and confirm here."],
  ["Your own secure ID check", "Your own ID upload, accepted as given"],
  ["Check ID and confirm", "Upload ID and confirm"],
];

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function elementsOf(message: Line): Obj | undefined {
  const elements = message[3];
  return isObj(elements) ? elements : undefined;
}

function sayOf(ctx: EditContext, id: string): readonly Line[] {
  const say = ctx.step(id)?.say;
  return Array.isArray(say) ? say : [];
}

function idUploadMore(ctx: EditContext, id: string): void {
  const more = ctx.step(id)?.more;
  if (!Array.isArray(more)) return;
  const first = more.findIndex((line) => FACE_OR_VIDEO.test(line));
  for (let k = more.length - 1; k >= 0; k -= 1) {
    const line = more[k];
    if (line !== undefined && FACE_OR_VIDEO.test(line)) ctx.remove(id, ["more", k]);
  }
  const now = ctx.step(id)?.more ?? [];
  let at = first >= 0 ? first : now.length;
  for (const line of ID_UPLOAD_LINES) {
    if (now.includes(line)) continue;
    ctx.insert(id, ["more"], Math.min(at, (ctx.step(id)?.more ?? []).length), line);
    at += 1;
  }
}

function idUploadPage(ctx: EditContext, id: string): void {
  sayOf(ctx, id).forEach((message, k) => {
    const elements = elementsOf(message);
    const card = elements?.card;
    if (isObj(card) && Array.isArray(card.lines)) {
      const lines = card.lines as unknown[];
      const face = lines.some((line) => typeof line === "string" && FACE_OR_VIDEO.test(line));
      for (let j = lines.length - 1; j >= 0; j -= 1) {
        const line = lines[j];
        if (typeof line === "string" && FACE_OR_VIDEO.test(line))
          ctx.remove(id, ["say", k, 3, "card", "lines", j]);
      }
      if (face && !lines.includes(ID_UPLOAD_CARD_LINE))
        ctx.insert(id, ["say", k, 3, "card", "lines"], 0, ID_UPLOAD_CARD_LINE);
    }
    const form = elements?.form;
    if (Array.isArray(form) && form.some((field) => typeof field === "string" && FACE_OR_VIDEO.test(field))) {
      const kept = (form as unknown[]).filter(
        (field) => !(typeof field === "string" && FACE_OR_VIDEO.test(field)),
      );
      const fields = kept.map((field) =>
        typeof field === "string" && /license photo/i.test(field) ? ID_UPLOAD_FIELD : field,
      );
      if (!fields.includes(ID_UPLOAD_FIELD)) fields.unshift(ID_UPLOAD_FIELD);
      ctx.set(id, ["say", k, 3, "form"], fields);
    }
  });
}

function ownerId(ctx: EditContext): void {
  const id = "S1-10";
  if (ctx.step(id) === undefined) return;
  ctx.rewriteLines(id, S1_10_LINES);
  idUploadMore(ctx, id);
  idUploadPage(ctx, id);
}

function goLiveGate(ctx: EditContext): void {
  const id = "S1-32";
  const step = ctx.step(id);
  if (step === undefined) return;
  ctx.rewriteLines(id, S1_32_LINES, ["more"]);
  const branch = (step.branches ?? []).find((candidate) => candidate.label === "The ID doesn't match");
  // A trade's own `off` of the branch stays as the trade wrote it.
  if (branch !== undefined && branch.off === undefined)
    ctx.switchOffBranch(id, "The ID doesn't match", ID_ACCEPTED_OFF);
}

function helperOwnerId(ctx: EditContext): void {
  const id = "S1-77";
  if (ctx.step(id) === undefined) return;
  ctx.rewriteLines(id, S1_77_LINES);
}

/** C10: the owner's ID is an upload, accepted as given; no face match or video check runs. */
export const c10: Correction = {
  id: "C10",
  title: "The owner's ID is an upload accepted as given; no face match or video check",
  source: "Master Corrections C10; section 8 (ID check, J-15); RULES 9.5, 10.4; FRONTEND-SPEC row B14",
  apply(ctx) {
    ownerId(ctx);
    goLiveGate(ctx);
    helperOwnerId(ctx);
  },
};
