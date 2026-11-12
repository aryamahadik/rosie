// The types of live-check.mjs's exports (T-419), so its tests are typed; the script itself is plain JavaScript.
import type { SendEmailRequest } from "./types";

export declare const KEY_NAME: "RESEND_API_KEY";
export declare const LIST_NAME: "STAGING_TEST_INBOXES";
export declare const TEST_INBOX: "delivered@resend.dev";
export declare const VARS_FILE: ".dev.vars";
export declare const FROM: { readonly name: string; readonly address: string };

/** What the live check reads and writes, handed in (the script hands in process.env, the working folder and the console). */
export interface LiveCheckIo {
  readonly argv?: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly now?: () => string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export declare function readDevVar(file: string, name: string): string | undefined;
export declare function liveCheckEmail(at: string, nonce: string): SendEmailRequest;
export declare function runLiveCheck(io: LiveCheckIo): Promise<number>;
