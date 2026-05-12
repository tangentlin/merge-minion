import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PrUpdateRecord {
  lastUpdatedAt: string;
  resultingSha: string;
}

export type StateMap = Record<string, PrUpdateRecord>;

const DEFAULT_PATH = join(homedir(), ".merge-minion", "state.json");

export function prKey(repoSlug: string, prNumber: number): string {
  return `${repoSlug}#${prNumber}`;
}

export class State {
  private map: StateMap = {};

  constructor(private path: string = DEFAULT_PATH) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.map = parsed as StateMap;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  get(key: string): PrUpdateRecord | undefined {
    return this.map[key];
  }

  set(key: string, record: PrUpdateRecord): void {
    this.map[key] = record;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.map, null, 2), "utf8");
    await rename(tmp, this.path);
  }
}

export function isWithinCooldown(
  record: PrUpdateRecord | undefined,
  cooldownMinutes: number,
  now: Date = new Date(),
): boolean {
  if (!record) return false;
  const last = new Date(record.lastUpdatedAt).getTime();
  if (Number.isNaN(last)) return false;
  const ageMs = now.getTime() - last;
  return ageMs < cooldownMinutes * 60_000;
}
