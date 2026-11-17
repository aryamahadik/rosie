// The types of logs.mjs's exports (T-417), so the live check's tests are typed; the module itself is plain JavaScript.

/** One K-08 span staging logged, with its request's path (null for an event that is no request). */
export interface TailRecord {
  readonly span: Readonly<Record<string, unknown>>;
  readonly path: string | null;
}

/** What a read of the tail gives: the next span, nothing within the time, or the tail's end (its exit code). */
export type TailRead =
  | { readonly kind: "record"; readonly record: TailRecord }
  | { readonly kind: "timeout" }
  | { readonly kind: "ended"; readonly code: number | null };

/** Staging's logs, open: one reader at a time. */
export interface LogTail {
  read(timeoutMs: number): Promise<TailRead>;
  close(): Promise<void>;
}

/** The part of a child process the reader uses (node:child_process's ChildProcess has it). */
export interface TailChild {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** What the reader hands the process it starts. */
export interface TailSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
}

/** Starts the tail's process (node:child_process spawn, unless a test hands in its own). */
export type SpawnProcess = (command: string, args: readonly string[], options: TailSpawnOptions) => TailChild;

export declare const TAIL_ARGS: readonly ["tail", "--env", "staging", "--format", "json"];
export declare const TAIL_DESCRIPTION: string;

export declare class TailJsonStream {
  push(chunk: string): Record<string, unknown>[];
}

export declare function recordsOfTailEvent(event: unknown): TailRecord[];
export declare function tailEnv(
  env: Readonly<Record<string, string | undefined>>,
  dropped: readonly string[],
): Record<string, string>;
export declare function openStagingTail(options: {
  readonly root: string;
  readonly env: Readonly<Record<string, string>>;
  readonly spawnProcess?: SpawnProcess;
}): LogTail;
