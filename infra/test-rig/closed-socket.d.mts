// Types of closed-socket.mjs (T-1253; DL-758), for vitest.config.ts.
import type { Plugin } from "vitest/config";

/** postgres.js's closed-socket rejection, as Vitest hands it to onUnhandledError. */
export declare const CLOSED_SOCKET: Readonly<{
  name: "TypeError";
  message: "This socket has been closed.";
  type: "Unhandled Rejection";
  file: "node_modules/postgres/cf/polyfills.js";
}>;

/** The file of the first frame of a V8 stack, or undefined. */
export declare function firstFrameFile(stack: unknown): string | undefined;

/** Whether an unhandled error is postgres.js's closed-socket rejection: all four fields match. */
export declare function isClosedSocketRejection(error: unknown): boolean;

/** The one line a run prints: how many it dropped, and no value of any error. */
export declare function droppedLine(count: number): string;

export interface ClosedSocketFilter {
  /** test.onUnhandledError: false (drop) for postgres.js's closed-socket rejection alone; undefined (keep) otherwise. */
  readonly onUnhandledError: (error: unknown) => false | undefined;
  /** How many it has dropped so far. */
  readonly dropped: () => number;
}

/** vitest.config.ts's filter. */
export declare function closedSocketFilter(): ClosedSocketFilter;

/** A Vite plugin for the Workers projects that prints droppedLine once when the run closes. */
export declare function droppedReport(filter: ClosedSocketFilter): Plugin;
