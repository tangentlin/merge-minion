import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type UpdateMethod = "merge" | "rebase";

export interface RepoConfig {
  slug: string;
  updateMethod?: UpdateMethod;
  waitForCi?: boolean;
}

export interface Config {
  repos: RepoConfig[];
  cooldownMinutes: number;
  dryRun: boolean;
}

const DEFAULT_PATH = join(homedir(), ".merge-minion", "config.json");

export async function loadConfig(path: string = DEFAULT_PATH): Promise<Config> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return validate(parsed);
}

function validate(input: unknown): Config {
  if (!isObject(input)) throw new Error("config: root must be an object");

  const reposRaw = input.repos;
  if (!Array.isArray(reposRaw) || reposRaw.length === 0) {
    throw new Error("config.repos: must be a non-empty array");
  }
  const repos: RepoConfig[] = reposRaw.map((r, i) => {
    if (!isObject(r)) throw new Error(`config.repos[${i}]: must be an object`);
    if (typeof r.slug !== "string" || !/^[^/]+\/[^/]+$/.test(r.slug)) {
      throw new Error(`config.repos[${i}].slug: must be "owner/repo"`);
    }
    const m = r.updateMethod;
    if (m !== undefined && m !== "merge" && m !== "rebase") {
      throw new Error(`config.repos[${i}].updateMethod: must be "merge" or "rebase"`);
    }
    const w = r.waitForCi;
    if (w !== undefined && typeof w !== "boolean") {
      throw new Error(`config.repos[${i}].waitForCi: must be a boolean`);
    }
    return {
      slug: r.slug,
      updateMethod: m as UpdateMethod | undefined,
      waitForCi: w,
    };
  });

  const cooldownMinutes =
    typeof input.cooldownMinutes === "number" ? input.cooldownMinutes : 15;
  if (cooldownMinutes < 0) throw new Error("config.cooldownMinutes: must be >= 0");

  const dryRun = input.dryRun === true;

  return { repos, cooldownMinutes, dryRun };
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
