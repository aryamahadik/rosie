// A numbered build: the bundle under its own bundle id, with every input K-01 names (T-150; C-072; CQ-09; K-01 v1).
//
//   withBundleId()         an emitted bundle under another bundle id: the manifest's bundleId, its own key and each
//                          stored value's key (bundle/<hash>/<build>/<part>) are rewritten, manifest.json is written
//                          again, and the manifest is checked against K-01 v1. The stored values carry no bundle id (K-01
//                          "Storage"), so their files stay byte for byte; the result is what emitBundle() writes when it
//                          is given that id from the start (numbered.test.ts checks it).
//   numberBundle()         an emitted bundle under its own id: the content hash of its files (content-hash.ts) with the
//                          build number given.
//   buildNumberedBundle()  buildBundle() (T-149) given every input K-01 names (inputs.ts), then numberBundle(): what
//                          `compiler build --build <n>` writes. The values' hash is known only once they are compiled, so
//                          the emitter compiles them once under a provisional id (the emitter's stand-in id, passed in,
//                          so it is not named as a stand-in) and numberBundle() puts the real one in its place.
import type { BuildOptions, BuiltBundle, BundleId, EmittedBundle } from "../emit";
import { STANDIN_BUNDLE_ID, assertBundlePart, buildBundle } from "../emit";
import { listTradeIds } from "../load/trade";
import { BundleIdError, contentHashOfFiles, isBuildNumber, keyPrefix } from "./content-hash";
import { bundleInputs, type ApprovedOverlay } from "./inputs";

/** The id a numbered build's values are compiled under before their hash is known: the emitter's stand-in id. */
export const PROVISIONAL_BUNDLE_ID: Readonly<BundleId> = STANDIN_BUNDLE_ID;

const SHA256 = /^[0-9a-f]{64}$/;

/** The manifest's fields withBundleId() rewrites. */
interface Keyed {
  bundleId: BundleId;
  storage: { manifestKey: string; values: { key: string }[] };
}

/** `emitted` under the bundle id `id` (see the top of this file). Throws BundleIdError on a malformed id. */
export function withBundleId(emitted: EmittedBundle, id: BundleId): EmittedBundle {
  if (!SHA256.test(id.hash)) throw new BundleIdError(`"${id.hash}" is not a sha256 in lowercase hex`);
  if (!isBuildNumber(id.build))
    throw new BundleIdError(`${String(id.build)} is not a build number (a whole number from 1)`);
  const manifest = structuredClone(emitted.bundle.manifest);
  const keyed = manifest as unknown as Keyed;
  const from = keyPrefix(keyed.bundleId);
  const to = keyPrefix(id);
  if (keyed.storage.manifestKey !== `${from}manifest`)
    throw new BundleIdError(`storage.manifestKey is not ${from}manifest`);
  keyed.storage.manifestKey = `${to}manifest`;
  for (const value of keyed.storage.values) {
    if (!value.key.startsWith(from))
      throw new BundleIdError(`${value.key} is not under the bundle id ${from}`);
    value.key = `${to}${value.key.slice(from.length)}`;
  }
  keyed.bundleId = { hash: id.hash, build: id.build };
  assertBundlePart(manifest, "the manifest under its bundle id", "manifest");
  const text = JSON.stringify(manifest);
  return {
    bundle: { ...emitted.bundle, manifest },
    files: emitted.files.map((file) => (file.path === "manifest.json" ? { path: file.path, text } : file)),
  };
}

/** `emitted` under its own bundle id: the content hash of its stored values, with build number `build`. */
export function numberBundle(emitted: EmittedBundle, build: number): EmittedBundle & { bundleId: BundleId } {
  if (!isBuildNumber(build))
    throw new BundleIdError(`${String(build)} is not a build number (a whole number from 1)`);
  const bundleId = { hash: contentHashOfFiles(emitted.files), build };
  return { ...withBundleId(emitted, bundleId), bundleId };
}

/** What buildNumberedBundle() is given: buildBundle()'s options but the id and inputs, which it makes itself. */
export interface NumberedBuildOptions extends Omit<BuildOptions, "bundleId" | "inputs"> {
  /** The build number, counting publishes from 1 (K-01 manifest.bundleId.build); the publish picks it (T-152). */
  build: number;
  /** The overlays Jay approved that the bundle is built with (default: none; Q-17, J-18). */
  approvedOverlays?: readonly ApprovedOverlay[];
}

/** A numbered build: the built bundle (T-149), under its bundle id. */
export interface NumberedBundle extends BuiltBundle {
  bundleId: BundleId;
}

/** Builds fixture set v1 into a bundle under its own bundle id, with every input K-01 names (the top of this file). */
export async function buildNumberedBundle(options: NumberedBuildOptions): Promise<NumberedBundle> {
  const { build, approvedOverlays, ...rest } = options;
  // Checked before the build, which takes minutes with every trade.
  if (!isBuildNumber(build))
    throw new BundleIdError(`${String(build)} is not a build number (a whole number from 1)`);
  const trades = rest.trades ?? listTradeIds();
  const inputs = bundleInputs(approvedOverlays === undefined ? { trades } : { trades, approvedOverlays });
  const built = await buildBundle({ ...rest, trades, inputs, bundleId: { ...PROVISIONAL_BUNDLE_ID } });
  return { ...built, ...numberBundle(built, build) };
}
