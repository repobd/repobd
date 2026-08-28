#!/usr/bin/env node
// RepoBD CLI entry point. Argument parsing and the real I/O only — the flows
// themselves live in `commands.ts` so they can be tested without a process.

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EXIT_BLOCKED,
  EXIT_OK,
  PULL_TAKES_NO_ARGUMENT,
  hasUnexpectedPullOperand,
  runPull,
  runSend,
} from "./commands.js";
import { redactingOutput } from "./diagnostics.js";
import { promptForDeliveryLink, promptForSecret } from "./prompt.js";

// `package.json` is the one place the release version is written; nothing
// here restates it. This file lives two directories below the package root
// both as `src/cli/index.ts` (run directly via `tsx`) and, after build, as
// `dist/cli/index.js` in an installed npm package — `package.json` sits at
// `../../package.json` from either location, since npm always ships it
// alongside whatever `files` lists.
const packageJson = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../package.json", import.meta.url)),
    "utf8",
  ),
) as { version: string };

// A delivery link contains the decryption key, and so does the secret a sender
// types. Both are read from stdin, never taken as a command-line argument, and
// never included in an error. The one link `send` prints on success is the
// command's product, and is the only place either ever appears in output.
const out = (line: string): void => {
  console.log(line);
};
const err = (line: string): void => {
  console.error(line);
};

const args = process.argv.slice(2);

const program = new Command();

// The diagnostic safety boundary, installed before any subcommand exists.
// Commander copies its parent's output configuration into each subcommand at
// creation time, so this must come first for the whole command tree to inherit
// it — every diagnostic, from every command, reaches the terminal through
// `diagnostics.ts` and cannot quote a user-supplied argument.
program.configureOutput(
  redactingOutput(args, {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  }),
);

program
  .name("repobd")
  .description("Repo-bound secret transport.\n\nWrong repo. No secret.")
  .version(packageJson.version)
  .addHelpText(
    "after",
    `
Examples:
  repobd send
  repobd pull

How it works:
  1. Run \`repobd send\` in the intended repository.
  2. Enter one KEY and VALUE.
  3. Share the generated delivery link through a private, trusted channel
     — it is secret-bearing.
  4. Run \`repobd pull\` in the receiving repository.
  5. RepoBD applies it only when the repository identity matches.

More:
  https://github.com/repobd/repobd`,
  );

program
  .command("send")
  .description(
    "Create a one-time secret delivery bound to this repository",
  )
  .addHelpText(
    "after",
    `
RepoBD derives repository identity from the current repository's origin
remote.

You will be prompted for:
  KEY
  VALUE`,
  )
  .action(async () => {
    const code = await runSend({
      readSecret: promptForSecret,
      cwd: process.cwd(),
      out,
      err,
    });
    if (code !== EXIT_OK) {
      process.exitCode = code;
    }
  });

program
  .command("pull")
  .description(
    "Retrieve and apply a delivery only if this repository matches",
  )
  .addHelpText(
    "after",
    `
The delivery is rejected before secret retrieval if the repository
identity does not match.

On success, the value is applied to this repository's root .env file.`,
  )
  .action(async () => {
    const code = await runPull({
      readLink: promptForDeliveryLink,
      cwd: process.cwd(),
      out,
      err,
    });
    if (code !== EXIT_OK) {
      process.exitCode = code;
    }
  });

// A friendlier message for the most likely mistake, `repobd pull <link>`.
// This is UX, **not** the security boundary: it covers one argv shape, while
// the redacting output configuration above covers every shape, including the
// ones this check deliberately does not try to enumerate. The value is never
// read here either — only its presence.
if (hasUnexpectedPullOperand(args)) {
  err(PULL_TAKES_NO_ARGUMENT);
  process.exit(EXIT_BLOCKED);
}

await program.parseAsync(process.argv);
