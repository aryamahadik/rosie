import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FICTIONAL_PHONE, phoneNumbersIn } from "../../../infra/ci/phone-scan.mjs";
import { decodeSvg } from "./decode.mjs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const unescape = (s) =>
  s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

const sections = [...html.matchAll(/<section data-form="([^"]+)">([\s\S]*?)<\/section>/g)].map((m) => ({
  id: m[1],
  link: unescape(/<code class="link"\s*>([\s\S]*?)<\/code\s*>/.exec(m[2])[1].trim()),
  svg: /<svg[\s\S]*?<\/svg>/.exec(m[2])[0],
}));

test("page lists at least five candidate forms for iOS and Android", () => {
  assert.ok(sections.length >= 5);
  assert.ok(html.includes("Targets: iOS"));
  assert.ok(html.includes("Targets: Android"));
});

for (const s of sections) {
  test(`QR for ${s.id} decodes to exactly its link`, () => {
    assert.equal(decodeSvg(s.svg), s.link);
  });
}

test("links address only the Shared line and carry the ready text", () => {
  for (const s of sections) {
    assert.match(s.link, /^sms:(\/\/)?\+15555550123(?:[?&]|$)/);
    if (!s.link.endsWith("+15555550123")) assert.ok(s.link.includes("ZX7Q4K"));
  }
});

test("page uses no real numbers and makes no network calls", () => {
  const numbers = html.match(/\+\d{8,}/g) ?? [];
  assert.ok(numbers.every((n) => n === "+15555550123"));
  assert.ok(!/(src|href)="https?:/.test(html));
  assert.ok(!/<script/i.test(html));
});

// No file of the spike holds a phone number outside the fiction range (T-1316): the repository is public (DL-436) and
// no real phone number goes in it (DL-542). The range is +1, an area code, then 555-0100 to 555-0199, as
// adapters/src/shared/samples.ts reads it. A number is found however it is written, by the repository's own phone scan
// (infra/ci/phone-scan.mjs: FICTIONAL_PHONE and phoneNumbersIn, with every shape it reads since T-1317, T-1332 and
// T-1344), so the spike keeps no copy of the shapes to fall behind them (T-1344).

/** The names of the files (name to text) that hold a number outside the fiction range, never the number itself. */
const outsideFiction = (files) =>
  Object.entries(files)
    .filter(([, text]) => phoneNumbersIn(text).some((number) => !FICTIONAL_PHONE.test(number)))
    .map(([name]) => name);

test("no file of the spike holds a phone number outside the fiction range", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const files = {};
  for (const name of readdirSync(dir, { recursive: true })) {
    if (statSync(path.join(dir, name)).isFile()) files[name] = readFileSync(path.join(dir, name), "utf8");
  }
  assert.ok(["build.mjs", "chat-link.test.mjs", "decode.mjs", "index.html"].every((name) => name in files));
  assert.deepEqual(outsideFiction(files), []);
  // The scan finds the line's number where the build sets it and in the page the build made.
  assert.deepEqual(phoneNumbersIn(files["build.mjs"]), ["+15555550123"]);
  assert.deepEqual(phoneNumbersIn(files["index.html"]), ["+15555550123"]);
});

test("the scan finds a number however it is written, and names only a file outside the range", () => {
  for (const written of [
    "+15555550123",
    "+1 555 555 0123",
    "+1 (555) 555-0123",
    "(555) 555-0123",
    "555-555-0123",
    "555.555.0123",
    "1-555-555-0123",
  ]) {
    assert.deepEqual(phoneNumbersIn(`sms:${written}&body=x`), ["+15555550123"], written);
  }
  // No North American area code starts with 0, so this number is no one's. It is made at run time, so no file of the
  // spike holds it.
  const noOnes = ["+1", "055", "555", "0123"].join("");
  const files = { "a.html": `<a href="sms:${noOnes}">`, "b.mjs": 'const line = "+15555550123";' };
  assert.deepEqual(outsideFiction(files), ["a.html"]);
});
