// What the Workers test rig's globalSetup (infra/test-rig/global-setup.mjs) provides to both Workers projects, by the
// names rig.mjs's PROVIDED gives them (T-1253; Vitest's provide and inject). Optional: a project that ran without the
// rig has neither, and vitest.config.ts's pool function refuses to start the pool then.
declare module "vitest" {
  export interface ProvidedContext {
    /** Each pool Hyperdrive binding's local string, by binding name: miniflare's hyperdrives (vitest.config.ts). */
    rosieRigHyperdrives?: Readonly<Record<string, string>>;
    /** The database of each named file that has one (infra/test-rig/files.mjs), by the file's key. */
    rosieRigDatabases?: Readonly<Record<string, string>>;
  }
}

export {};
