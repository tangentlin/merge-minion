import type { CheckRollup, PullRequest, ReviewSummary } from "./github.ts";
import { isWithinCooldown, type PrUpdateRecord } from "./state.ts";

export type GateName =
  | "approved"
  | "auto_merge_on"
  | "mergeable_known"
  | "behind_main"
  | "ci_not_red"
  | "ci_settled"
  | "cooldown";

export interface GateResult {
  pass: boolean;
  reason?: string;
}

export type GateResults = Record<GateName, GateResult>;

export function approved(reviews: ReviewSummary): GateResult {
  if (reviews.changesRequestedByLatest > 0) {
    return { pass: false, reason: "changes requested" };
  }
  if (reviews.approvalsByLatest < 1) {
    return { pass: false, reason: "no approval" };
  }
  return { pass: true };
}

export function autoMergeOn(pr: PullRequest): GateResult {
  return pr.autoMergeEnabled
    ? { pass: true }
    : { pass: false, reason: "auto-merge disabled" };
}

export function mergeableKnown(pr: PullRequest): GateResult {
  return pr.mergeable === null
    ? { pass: false, reason: "mergeable computing (null)" }
    : { pass: true };
}

export function behindMain(pr: PullRequest): GateResult {
  if (pr.mergeableState === "behind") return { pass: true };
  return { pass: false, reason: `mergeable_state=${pr.mergeableState}` };
}

export function ciNotRed(checks: CheckRollup): GateResult {
  if (checks.hasFailing) return { pass: false, reason: "ci has failing checks" };
  return { pass: true };
}

export function ciSettled(checks: CheckRollup, waitForCi: boolean): GateResult {
  if (!waitForCi) return { pass: true };
  if (checks.inProgress > 0) {
    return { pass: false, reason: `${checks.inProgress} checks in progress` };
  }
  return { pass: true };
}

export function cooldown(
  record: PrUpdateRecord | undefined,
  cooldownMinutes: number,
  now: Date = new Date(),
): GateResult {
  if (isWithinCooldown(record, cooldownMinutes, now)) {
    return { pass: false, reason: `in cooldown (<${cooldownMinutes}m since last update)` };
  }
  return { pass: true };
}

export function evaluateAll(args: {
  pr: PullRequest;
  reviews: ReviewSummary;
  checks: CheckRollup;
  record: PrUpdateRecord | undefined;
  cooldownMinutes: number;
  waitForCi: boolean;
  now?: Date;
}): { results: GateResults; allPass: boolean } {
  const results: GateResults = {
    approved: approved(args.reviews),
    auto_merge_on: autoMergeOn(args.pr),
    mergeable_known: mergeableKnown(args.pr),
    behind_main: behindMain(args.pr),
    ci_not_red: ciNotRed(args.checks),
    ci_settled: ciSettled(args.checks, args.waitForCi),
    cooldown: cooldown(args.record, args.cooldownMinutes, args.now),
  };
  const allPass = Object.values(results).every((r) => r.pass);
  return { results, allPass };
}
