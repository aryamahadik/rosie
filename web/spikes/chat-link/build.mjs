// T-1120 spike: builds index.html, a device-check page of candidate chat links
// with inline SVG QR codes (uqr). Fixture values only; no network calls.
// Run: node web/spikes/chat-link/build.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderSVG } from "uqr";

// Fixtures, all made up. The number is a fiction-range one (+1 NPA 555-01xx), not a real line: the repository is
// public and no real phone number goes in it (DL-436, DL-542; T-1316). The code and the text are made up too.
export const FIXTURE = {
  sharedLine: "+15555550123",
  shortCode: "ZX7Q4K",
  readyText: "Hi Rosie, I would like to book. Code ZX7Q4K",
};

const enc = encodeURIComponent(FIXTURE.readyText);
const n = FIXTURE.sharedLine;

export const CANDIDATES = [
  {
    id: "ios-ampersand",
    platform: "iOS",
    note: "iOS Messages form: number, then &body= (iOS reads & as the body separator).",
    link: `sms:${n}&body=${enc}`,
  },
  {
    id: "android-question",
    platform: "Android",
    note: "Android and RFC 5724 form: number, then ?body=.",
    link: `sms:${n}?body=${enc}`,
  },
  {
    id: "both-question-ampersand",
    platform: "iOS and Android",
    note: "Hybrid ?&body= form that some say both platforms accept; check it on both.",
    link: `sms:${n}?&body=${enc}`,
  },
  {
    id: "ios-double-slash",
    platform: "iOS",
    note: "sms:// with &body=; an older iOS form, check whether Messages still opens it.",
    link: `sms://${n}&body=${enc}`,
  },
  {
    id: "android-double-slash",
    platform: "Android",
    note: "sms:// with ?body=; seen in older Android guides.",
    link: `sms://${n}?body=${enc}`,
  },
  {
    id: "number-only",
    platform: "iOS and Android",
    note: "Fallback: Messages addressed to the line with no body; the customer types the code.",
    link: `sms:${n}`,
  },
];

const escapeHtml = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function buildPage() {
  const sections = CANDIDATES.map((c) => {
    const svg = renderSVG(c.link, { ecc: "L", border: 4, pixelSize: 1 });
    return `<section data-form="${c.id}">
<h2>${c.id}</h2>
<p class="platform">Targets: ${c.platform}</p>
<p class="note">${escapeHtml(c.note)}</p>
<p><a href="${escapeHtml(c.link)}"><code class="link">${escapeHtml(c.link)}</code></a></p>
<figure class="qr">${svg}</figure>
</section>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Chat link device check (T-1120)</title>
<style>
body { font-family: system-ui, sans-serif; margin: 1rem; max-width: 40rem; }
section { border-top: 1px solid #ccc; padding: 1rem 0; }
code { word-break: break-all; }
figure.qr { margin: 0; }
figure.qr svg { width: 16rem; height: 16rem; }
</style>
</head>
<body>
<h1>Chat link device check</h1>
<p>Fixture values only. Line: ${escapeHtml(FIXTURE.sharedLine)} (fiction range, made up). Short code: ${escapeHtml(FIXTURE.shortCode)} (made up). Scan each code and tap each link on a real phone.</p>
${sections}
</body>
</html>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL("./index.html", import.meta.url), buildPage());
}
