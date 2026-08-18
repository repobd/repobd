import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

// Applies migrations/*.sql to the local test database. Runs against
// Miniflare's local D1 only — no remote database is contacted.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
