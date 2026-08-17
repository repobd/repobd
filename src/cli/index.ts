#!/usr/bin/env node
import { Command } from "commander";

// Phase 0: scaffold only. `send` and `pull` are stubs with no product
// behavior. Real implementation lands in later phases per
// docs/IMPLEMENTATION_PLAN.md.

const program = new Command();

program.name("repobd").description("RepoBD CLI").version("0.0.0");

program
  .command("send")
  .description("Send a secret (not yet implemented)")
  .action(() => {
    console.error("repobd send: not yet implemented (Phase 0 scaffold)");
    process.exitCode = 1;
  });

program
  .command("pull")
  .description("Pull a secret (not yet implemented)")
  .action(() => {
    console.error("repobd pull: not yet implemented (Phase 0 scaffold)");
    process.exitCode = 1;
  });

program.parse(process.argv);
