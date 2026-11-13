// T-410: the recorded-sample loader reads a port's samples and refuses one that could hold real data (rules 7 and 9).
// The samples here are written to a temporary folder, with fictional values only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PORT_FOLDERS } from "./ports";
import {
  RecordedSampleError,
  listRecordedSamples,
  loadRecordedSample,
  loadRecordedSampleText,
  samplesDir,
} from "./samples";

let dir: string;

function write(name: string, text: string): void {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), text);
}

function problemsOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof RecordedSampleError) return error.problems;
    throw error;
  }
  return [];
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rosie-samples-"));
  write("good.json", JSON.stringify({ id: "msg-1", to: "+14155550123", email: "a@example.com" }));
  write("raw/body.txt", '{"id":"evt-1","n":1}\n');
  write("bad-phone.json", JSON.stringify({ to: "+15555559999" }));
  write("bad-email.json", JSON.stringify({ email: "someone@gmail.com" }));
  write("bad-key.json", JSON.stringify({ auth: ["sk_", "live_", "0123456789abcdef"].join("") }));
  write("bad-bearer.json", JSON.stringify({ header: "Bearer abcdefgh01234567" }));
  write("broken.json", "{not json");
  write("own-line.json", JSON.stringify({ from: "+12055550100", line: "+15555559999" }));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("recorded-sample loader", () => {
  it("loads a JSON sample and a raw sample byte for byte", () => {
    expect(loadRecordedSample(dir, "good.json")).toEqual({
      id: "msg-1",
      to: "+14155550123",
      email: "a@example.com",
    });
    expect(loadRecordedSampleText(dir, "raw/body.txt")).toBe('{"id":"evt-1","n":1}\n');
  });

  it("lists the files of a samples folder, sorted, and nothing for a folder that is not there", () => {
    expect(listRecordedSamples(dir)).toEqual([
      "bad-bearer.json",
      "bad-email.json",
      "bad-key.json",
      "bad-phone.json",
      "broken.json",
      "good.json",
      "own-line.json",
    ]);
    expect(listRecordedSamples(path.join(dir, "missing"))).toEqual([]);
  });

  it("refuses a real-looking phone number, email address and key, naming the file and the kind but not the value", () => {
    expect(problemsOf(() => loadRecordedSample(dir, "bad-phone.json"))).toEqual([
      "bad-phone.json: holds a phone number that is not a fictional one (+1 xxx 555 01xx)",
    ]);
    expect(problemsOf(() => loadRecordedSample(dir, "bad-email.json"))).toEqual([
      "bad-email.json: holds an email address outside the reserved example domains",
    ]);
    expect(problemsOf(() => loadRecordedSample(dir, "bad-key.json"))).toEqual([
      "bad-key.json: holds a key-shaped value",
    ]);
    expect(problemsOf(() => loadRecordedSample(dir, "bad-bearer.json"))).toEqual([
      "bad-bearer.json: holds a key-shaped value",
    ]);
  });

  it("lets the caller allow an exact value, such as Rosie's own line, and nothing near it", () => {
    expect(loadRecordedSample(dir, "own-line.json", { allow: ["+12055550100", "+15555559999"] })).toEqual({
      from: "+12055550100",
      line: "+15555559999",
    });
    expect(
      problemsOf(() => loadRecordedSample(dir, "bad-phone.json", { allow: ["+15555559998"] })),
    ).toHaveLength(1);
  });

  it("refuses a path outside the folder, a missing file and text that is not JSON", () => {
    expect(problemsOf(() => loadRecordedSample(dir, "../outside.json"))).toEqual([
      "../outside.json: is outside the samples folder",
    ]);
    expect(problemsOf(() => loadRecordedSample(dir, path.join(dir, "good.json")))).toEqual([
      `${path.join(dir, "good.json")}: is outside the samples folder`,
    ]);
    expect(problemsOf(() => loadRecordedSample(dir, "missing.json"))).toEqual([
      "missing.json: cannot be read",
    ]);
    expect(problemsOf(() => loadRecordedSample(dir, "broken.json"))).toEqual([
      "broken.json: is not valid JSON",
    ]);
  });

  it("finds a port's samples at adapters/src/<port>/samples", () => {
    for (const port of PORT_FOLDERS) {
      expect(samplesDir(port).split(path.sep).slice(-4)).toEqual(["adapters", "src", port, "samples"]);
    }
  });
});
