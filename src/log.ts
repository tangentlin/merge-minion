type Level = "info" | "warn" | "error" | "debug";
export type LogFormat = "json" | "pretty";

let verbose = false;
let format: LogFormat = detectFormat();

export function setVerbose(v: boolean): void {
  verbose = v;
}

export function setLogFormat(f: LogFormat): void {
  format = f;
}

function detectFormat(): LogFormat {
  const env = process.env.LOG_FORMAT;
  if (env === "pretty" || env === "json") return env;
  return process.stdout.isTTY ? "pretty" : "json";
}

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const LEVEL_COLOR: Record<Level, string> = {
  debug: ANSI.gray,
  info: ANSI.cyan,
  warn: ANSI.yellow,
  error: ANSI.red,
};

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (level === "debug" && !verbose) return;
  const out = format === "pretty" ? formatPretty(level, msg, fields) : formatJson(level, msg, fields);
  if (level === "error" || level === "warn") {
    console.error(out);
  } else {
    console.log(out);
  }
}

function formatJson(level: Level, msg: string, fields?: Record<string, unknown>): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  });
}

function formatPretty(level: Level, msg: string, fields?: Record<string, unknown>): string {
  const useColor = process.stdout.isTTY;
  const ts = new Date().toISOString().slice(11, 19);
  const lvl = level.toUpperCase().padEnd(5);

  const inlineParts: string[] = [];
  const blockLines: string[] = [];
  const indent = " ".repeat(15); // align past "HH:MM:SS LEVEL " (8 + 1 + 5 + 1)

  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (isGateLike(v)) {
        const dimKey = color(useColor, ANSI.dim, `${k}:`);
        blockLines.push(`${indent}${dimKey} ${formatGates(v, useColor)}`);
      } else {
        inlineParts.push(`${color(useColor, ANSI.dim, k)}=${formatValue(v)}`);
      }
    }
  }

  const head = [
    color(useColor, ANSI.gray, ts),
    color(useColor, LEVEL_COLOR[level], lvl),
    color(useColor, ANSI.bold, msg),
  ].join(" ");
  const firstLine = inlineParts.length > 0 ? `${head} ${inlineParts.join(" ")}` : head;

  return blockLines.length === 0 ? firstLine : [firstLine, ...blockLines].join("\n");
}

function isGateLike(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  if (entries.length === 0) return false;
  return entries.every(
    ([, val]) => typeof val === "string" && (val === "pass" || val.startsWith("fail")),
  );
}

function formatGates(gates: Record<string, string>, useColor: boolean): string {
  return Object.entries(gates)
    .map(([k, v]) => {
      if (v === "pass") return `${color(useColor, ANSI.green, "✓")} ${k}`;
      const reason = v.startsWith("fail:") ? v.slice(5).trim() : "";
      const mark = color(useColor, ANSI.red, "✗");
      return reason ? `${mark} ${k} (${reason})` : `${mark} ${k}`;
    })
    .join("  ");
}

function color(enabled: boolean, code: string, text: string): string {
  return enabled ? `${code}${text}${ANSI.reset}` : text;
}

function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return /\s/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
};
