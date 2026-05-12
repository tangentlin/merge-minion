type Level = "info" | "warn" | "error" | "debug";

let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (level === "debug" && !verbose) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  };
  const out = JSON.stringify(line);
  if (level === "error" || level === "warn") {
    console.error(out);
  } else {
    console.log(out);
  }
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
};
