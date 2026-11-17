// The types of run.mjs's exports (T-417), so its tests are typed; the script itself is plain JavaScript.
import type { SendPartRequest } from "../send";
import type { SpawnProcess } from "./logs.mjs";

export declare const NAMES: {
  readonly key: "LINQ_API_TOKEN";
  readonly secret: "LINQ_WEBHOOK_SECRET";
  readonly line: "ROSIE_NUMBER";
  readonly roster: "STAGING_LINQ_ALLOWLIST";
  readonly to: "LINQ_PROBE_TO";
  readonly chat: "LINQ_LIVE_CHAT_ID";
};
export declare const VARS_FILE: ".dev.vars";
export declare const ROOT: string;
export declare const RECEIVED_SAMPLE: "webhook-message-received.json";
export declare const LINQ_WEBHOOK_PATH: "/webhooks/linq";
export declare const WORDS: string;
export declare const WAITS: {
  readonly settleMs: number;
  readonly replyMs: number;
  readonly traceMs: number;
};

/** The values as read by name, each "" when it is not set. */
export interface RawValues {
  readonly key: string;
  readonly secret: string;
  readonly line: string;
  readonly roster: string;
  readonly to: string;
  readonly chat: string;
}

/** The values once checked: the roster read into its numbers, the destination and step 3's number off the roster. */
export interface CheckedValues {
  readonly key: string;
  readonly secret: string;
  readonly line: string;
  readonly roster: readonly string[];
  readonly rosterText: string;
  readonly destination: string;
  readonly chat: string;
  readonly offRoster: string;
}

export declare function checkValues(raw: RawValues): {
  problems: string[];
  values: CheckedValues | null;
};
export declare function offRosterNumber(roster: readonly string[], line: string): string | null;
export declare function wordsRequest(to: string, chatId: string, idempotencyKey: string): SendPartRequest;

/** What the live check reads and writes, handed in (the script hands in process.env, the working folder and the console). */
export interface LiveCheckIo {
  readonly argv?: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly root?: string;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly spawnProcess?: SpawnProcess;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly waits?: { readonly settleMs?: number; readonly replyMs?: number; readonly traceMs?: number };
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export declare function runLiveCheck(io: LiveCheckIo): Promise<number>;
