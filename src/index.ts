#!/usr/bin/env -S npx tsx
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.ts";
import { GitHubClient } from "./github.ts";
import { log, setLogFormat, setVerbose, type LogFormat } from "./log.ts";
import { runTick } from "./minion.ts";
import { State } from "./state.ts";

interface Args {
  configPath: string;
  statePath: string;
  dryRun: boolean;
  verbose: boolean;
  once: boolean;
  intervalSeconds?: number;
  logFormat?: LogFormat;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    configPath: join(homedir(), ".merge-minion", "config.json"),
    statePath: join(homedir(), ".merge-minion", "state.json"),
    dryRun: false,
    verbose: false,
    once: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--verbose" || a === "-v") args.verbose = true;
    else if (a === "--once") args.once = true;
    else if (a === "--interval-seconds") {
      const next = argv[++i];
      if (!next) throw new Error("--interval-seconds requires a number");
      const n = Number(next);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error("--interval-seconds: must be > 0");
      }
      args.intervalSeconds = n;
    } else if (a === "--log-format") {
      const next = argv[++i];
      if (next !== "pretty" && next !== "json") {
        throw new Error("--log-format: must be 'pretty' or 'json'");
      }
      args.logFormat = next;
    } else if (a === "--config") {
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
      "By default, runs continuously and ticks every `tickIntervalSeconds`",
      "(from config, default 300). Pass --once to run a single tick and exit.",
      "",
      "Options:",
      "  --once                       Run a single tick and exit (default: loop forever)",
      "  --interval-seconds <n>       Override tick interval in seconds (overrides config)",
      "  --log-format <pretty|json>   Override log format (default: pretty if TTY, else json;",
      "                               also honors LOG_FORMAT env var)",
      "  --dry-run                    Evaluate gates and log decisions, but make no API mutations",
      "  --verbose, -v                Enable debug logging",
      "  --config <path>              Config path (default: ~/.merge-minion/config.json)",
      "  --state <path>               State path  (default: ~/.merge-minion/state.json)",
      "  --help, -h                   Print this help",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setVerbose(args.verbose);
  if (args.logFormat) setLogFormat(args.logFormat);

  const config = await loadConfig(args.configPath);
  if (args.dryRun) config.dryRun = true;
  if (args.intervalSeconds !== undefined) {
    config.tickIntervalSeconds = args.intervalSeconds;
  }

  const state = new State(args.statePath);
  await state.load();

  const github = await GitHubClient.create();

  const tickOnce = async (): Promise<void> => {
    try {
      await runTick({ config, github, state });
    } catch (err) {
      log.error("tick.failed", {
        message: (err as Error).message,
        stack: (err as Error).stack,
      });
    }
  };

  if (args.once) {
    await tickOnce();
    return;
  }

  const shutdown = new AbortController();
  let signaled = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      if (signaled) return;
      signaled = true;
      log.info("shutdown.signal", { signal: sig });
      shutdown.abort();
    });
  }

  const intervalMs = config.tickIntervalSeconds * 1000;
  log.info("loop.start", { intervalSeconds: config.tickIntervalSeconds });

  while (!shutdown.signal.aborted) {
    await tickOnce();
    if (shutdown.signal.aborted) break;
    try {
      await sleep(intervalMs, undefined, { signal: shutdown.signal });
    } catch {
      // AbortError from shutdown — fall through to loop check.
    }
  }

  log.info("loop.stop");
}

main().catch((err) => {
  log.error("fatal", { message: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
