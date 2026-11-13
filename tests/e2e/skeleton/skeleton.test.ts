// The walking skeleton's end-to-end test (C-148; build prompt section 10, D-017), its half in Node (T-1149): the one text
// it sends, Sam's JOIN (./join.ts), is a K-06 v1 event, checked by Ajv's compiler against the frozen schema on disk, which
// cannot run inside workerd. The run itself, one JOIN webhook through the Worker's own composition root with every joined
// hop, judged through SKELETON_UPTO's hop, runs inside workerd: ./skeleton.worker.test.ts (README.md).

import { describe, expect, it } from "vitest";

import { schemaProblems } from "../_driver";
import { JOIN } from "./join";

describe("the walking skeleton end to end: the text it sends", () => {
  it("sends Sam's JOIN as a K-06 v1 event", () => {
    expect(schemaProblems("inbound-event/inbound-event.v1.schema.json", undefined, JOIN)).toEqual([]);
  });
});
