import type { Config, RepoConfig } from "./config.ts";
import { evaluateAll, type GateResults } from "./gates.ts";
import type { GitHubClient, PullRequest } from "./github.ts";
import { log } from "./log.ts";
import { prKey, type State } from "./state.ts";

export interface TickOptions {
  config: Config;
  github: GitHubClient;
  state: State;
  now?: Date;
}

export async function runTick(opts: TickOptions): Promise<void> {
  const { config, github, state } = opts;
  const now = opts.now ?? new Date();

  log.info("tick.start", {
    viewer: github.viewerLogin,
    repos: config.repos.length,
    dryRun: config.dryRun,
  });

  for (const repoCfg of config.repos) {
    try {
      await processRepo(repoCfg, opts, now);
    } catch (err) {
      log.error("repo.error", {
        repo: repoCfg.slug,
        message: (err as Error).message,
      });
    }
  }

  await state.save();
  log.info("tick.end");
}

async function processRepo(
  repoCfg: RepoConfig,
  opts: TickOptions,
  now: Date,
): Promise<void> {
  const { config, github, state } = opts;
  const repoSlug = repoCfg.slug;

  const prs = await github.listOpenPrsAuthoredByViewer(repoSlug);
  if (prs.length === 0) {
    log.debug("repo.no_prs", { repo: repoSlug });
    return;
  }

  const sorted = [...prs].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  const candidates: { pr: PullRequest; results: GateResults }[] = [];

  for (const pr of sorted) {
    const reviews = await github.getReviewSummary(repoSlug, pr.number);
    const checks = await github.getCheckRollup(repoSlug, pr.headSha);
    const record = state.get(prKey(repoSlug, pr.number));
    const { results, allPass } = evaluateAll({
      pr,
      reviews,
      checks,
      record,
      cooldownMinutes: config.cooldownMinutes,
      waitForCi: repoCfg.waitForCi ?? false,
      now,
    });

    log.info("pr.evaluated", {
      repo: repoSlug,
      pr: pr.number,
      headSha: pr.headSha.substring(0, 7),
      gates: summarizeGates(results),
      candidate: allPass,
    });

    if (allPass) candidates.push({ pr, results });
  }

  if (candidates.length === 0) return;

  const leader = candidates[0];
  if (!leader) return;
  const pr = leader.pr;

  if (config.dryRun) {
    log.info("update.dry_run", { repo: repoSlug, pr: pr.number, headSha: pr.headSha });
    return;
  }

  const protection = await github.getBranchProtection(repoSlug, pr.baseRef);
  if (protection?.dismissStaleReviews) {
    log.warn("update.skipped_stale_dismissal", {
      repo: repoSlug,
      pr: pr.number,
      reason: "branch protection dismisses stale reviews; update would drop the approval",
    });
    return;
  }

  try {
    const { newHeadSha } = await github.updateBranch(
      repoSlug,
      pr.number,
      pr.headSha,
      repoCfg.updateMethod ?? "merge",
    );
    const resultingSha = newHeadSha ?? pr.headSha;
    state.set(prKey(repoSlug, pr.number), {
      lastUpdatedAt: now.toISOString(),
      resultingSha,
    });
    log.info("update.applied", {
      repo: repoSlug,
      pr: pr.number,
      method: repoCfg.updateMethod ?? "merge",
      newHeadSha: resultingSha.substring(0, 7),
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    log.error("update.failed", {
      repo: repoSlug,
      pr: pr.number,
      status,
      message: (err as Error).message,
    });
  }
}

function summarizeGates(results: GateResults): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, r] of Object.entries(results)) {
    out[name] = r.pass ? "pass" : `fail:${r.reason ?? ""}`;
  }
  return out;
}
