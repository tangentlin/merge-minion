#!/usr/bin/env -S npx tsx
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { GitHubClient } from "./github.ts";
import { log, setVerbose } from "./log.ts";
import { runTick } from "./minion.ts";
import { State } from "./state.ts";

interface Args {
  configPath: string;
  statePath: string;
  dryRun: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    configPath: join(homedir(), ".merge-minion", "config.json"),
    statePath: join(homedir(), ".merge-minion", "state.json"),
    dryRun: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--verbose" || a === "-v") args.verbose = true;
    else if (a === "--config") {
      const next = argv[++i];
      if (!next) throw new Error("--config requires a path");
      args.configPath = next;
    } else if (a === "--state") {
      const next = argv[++i];
      if (!next) throw new Error("--state requires a path");
      args.statePath = next;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      "merge-minion — keep your GitHub PRs current with main",
      "",
      "Usage: merge-minion [options]",
      "",
      "Options:",
      "  --dry-run         Evaluate gates and log decisions, but make no API mutations",
      "  --verbose, -v     Enable debug logging",
      "  --config <path>   Config path (default: ~/.merge-minion/config.json)",
      "  --state <path>    State path  (default: ~/.merge-minion/state.json)",
      "  --help, -h        Print this help",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setVerbose(args.verbose);

  const config = await loadConfig(args.configPath);
  if (args.dryRun) config.dryRun = true;

  const state = new State(args.statePath);
  await state.load();

  const github = await GitHubClient.create();

  await runTick({ config, github, state });
}

main().catch((err) => {
  log.error("fatal", { message: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
