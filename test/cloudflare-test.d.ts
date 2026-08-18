import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// `env` from `cloudflare:test` is typed as `Cloudflare.Env`, which is designed
// to be extended by declaration merging. TEST_MIGRATIONS is supplied by the
// pool from the Vitest config, not by wrangler.jsonc.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
