import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
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
    assert.match(s.link, /^sms:(\/\/)?\+12052611117(?:[?&]|$)/);
    if (!s.link.endsWith("+12052611117")) assert.ok(s.link.includes("ZX7Q4K"));
  }
});

test("page uses no real numbers and makes no network calls", () => {
  const numbers = html.match(/\+\d{8,}/g) ?? [];
  assert.ok(numbers.every((n) => n === "+12052611117"));
  assert.ok(!/(src|href)="https?:/.test(html));
  assert.ok(!/<script/i.test(html));
});
