// The chat link's QR code (T-513; MC C9: "The chat link, with a QR code beside it wherever a screen shows it"; K-03 v1's
// link.chatqr slot: "beside the link wherever a screen shows it (a page or an email, never a text)"): an inline SVG drawn
// on the Worker from the module matrix uqr encodes (0.1.3, in the root manifest and lockfile; T-331). No script, no
// image file and no outside resource: the SVG is part of the page, so the frame's content security policy, which loads
// nothing (shell/serve.ts), holds it as it is.
//
// The text goes to the encoder exactly as it is given (T-513's lead note 1). uqr writes a text in byte mode, as its UTF-8
// bytes, unless the text is all digits or all of the QR code's alphanumeric set (capitals, digits, space and $%*+-./:),
// and an sms: link never is (its scheme is lower case).
//
// The options (QR_OPTIONS), as T-513's lead note asks them named:
//   - error correction level L, never raised to a higher one (boostEcc off). L holds the most text in the fewest
//     modules, and a code shown on a clean screen needs little correction; T-1120's device-check page used L, and the
//     user's scan of it worked (web/spikes/chat-link/FINDINGS.md).
//   - version: the smallest of 1 to 40 that holds the text, uqr's own choice. K-09 v1's two chat links come out at
//     version 5 (chat-link-after-contact-add.json: 92 bytes, 37 by 37 modules) and version 4 (staff-join-link.json: 71
//     bytes, 33 by 33), inside what the tests' decoder reads (versions 1 to 6, level L, byte mode).
//   - a quiet zone of 4 light modules on every side (the QR standard's; T-1120's page used 4).
//   - the mask: uqr's choice.
// Drawn 4 CSS pixels to a module (version 5 with its quiet zone: 180 by 180 pixels), black on a white square, so the
// code reads the same on a dark page. Each row's dark modules are drawn as runs, with crisp edges, so no seam shows
// between two dark modules.

import { encode, type QrCodeGenerateOptions } from "uqr";
import { escapeHtml } from "../../shell/frame";

/** How the QR code is encoded (see the top of this file). */
export const QR_OPTIONS = {
  ecc: "L",
  boostEcc: false,
  minVersion: 1,
  maxVersion: 40,
  border: 4,
} as const satisfies QrCodeGenerateOptions;

/** CSS pixels to a module, as the SVG's width and height give it. */
export const QR_MODULE_PIXELS = 4;

/** The runs of dark modules in one row, left to right: each its first column and its length. */
function darkRuns(row: readonly boolean[]): (readonly [number, number])[] {
  const runs: (readonly [number, number])[] = [];
  /** The first column of the run under way, or -1 between runs. */
  let start = -1;
  for (const [column, dark] of row.entries()) {
    if (dark && start === -1) start = column;
    else if (!dark && start !== -1) {
      runs.push([start, column - start]);
      start = -1;
    }
  }
  if (start !== -1) runs.push([start, row.length - start]);
  return runs;
}

/**
 * The QR code of `text`, exactly as given, as an inline SVG (see the top of this file). `label` is its text
 * alternative, plain text: the image's accessible name (role img, aria-label) and its title.
 */
export function qrSvg(text: string, label: string): string {
  const { size, data } = encode(text, QR_OPTIONS);
  const path = data
    .flatMap((row, y) =>
      darkRuns(row).map(
        ([x, length]) => `M${String(x)},${String(y)}h${String(length)}v1h-${String(length)}z`,
      ),
    )
    .join("");
  const box = String(size);
  const pixels = String(size * QR_MODULE_PIXELS);
  const name = escapeHtml(label);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${name}" width="${pixels}" height="${pixels}" viewBox="0 0 ${box} ${box}" shape-rendering="crispEdges">`,
    `<title>${name}</title>`,
    `<rect width="${box}" height="${box}" fill="#fff"/>`,
    `<path fill="#000" d="${path}"/>`,
    "</svg>",
  ].join("");
}
