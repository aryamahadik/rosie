// Types for mock.mjs, the Tool API mock (C-186, T-510), for TypeScript callers such as the web app's page and console
// shells and QA's contract tests. An answer is a fixture's outcome: type it with the generated contract types
// (contracts/generated/, `npm run contracts:types`) of its call's response and errors.

/** The contracts the mock answers: K-09's Tool API and K-21's page and console calls. */
export type MockedContract = "tool-api" | "page-api";

/** Where a page runs: K-21's given.environment. */
export type MockEnvironment = "staging" | "production";

/** One fixture's answer in tool-api-mock.json. */
export interface MockAnswer {
  /** The fixture's path inside contracts/. */
  fixture: string;
  /** The contract version the fixture was written for. */
  version: string;
  /** The environment its given names; null where it names none (K-09), so it holds in both. */
  environment: MockEnvironment | null;
  request: unknown;
  outcome: unknown;
}

/** tool-api-mock.json, as generate.mjs writes it. */
export interface MockTable {
  about: string;
  contracts: Record<string, { versions: string[]; calls: Record<string, MockAnswer[]> }>;
}

/** Why no fixture answers: no such contract, no fixture of the call, or none holds this request here. */
export type ToolApiMockErrorCode = "unknownContract" | "unknownCall" | "noFixture";

/** The generated answers' file, beside mock.mjs. */
export declare const MOCK_FILE: string;

/** Where a page runs: K-21's given.environment. */
export declare const ENVIRONMENTS: readonly MockEnvironment[];

/** The mock's loud failure when no fixture answers a request; never an answer itself. */
export declare class ToolApiMockError extends Error {
  constructor(
    code: ToolApiMockErrorCode,
    where: { contract: unknown; call: unknown; environment: MockEnvironment },
    message: string,
  );
  readonly code: ToolApiMockErrorCode;
  readonly contract: string;
  readonly call: string;
  readonly environment: MockEnvironment;
}

export interface ToolApiMock {
  readonly environment: MockEnvironment;
  /** A copy of the outcome of the fixture whose request this is; throws ToolApiMockError when there is none. */
  answer(contract: MockedContract, call: string, request: unknown): unknown;
}

/** One text per JSON value, whatever the order of its keys; throws TypeError for a value JSON cannot send. */
export declare function canonicalJson(value: unknown): string;

/** A mock over one table (the parsed tool-api-mock.json), for pages that run in `environment`. */
export declare function createToolApiMock(
  table: unknown,
  options: { environment: MockEnvironment },
): ToolApiMock;

/** The mock over the committed tool-api-mock.json (or another table file), for pages that run in `environment`. */
export declare function loadToolApiMock(options: {
  environment: MockEnvironment;
  file?: string;
}): ToolApiMock;
