import { describe, it, expect } from "vitest";
import {
  approved,
  autoMergeOn,
  behindMain,
  ciNotRed,
  ciSettled,
  cooldown,
  evaluateAll,
  mergeableKnown,
} from "../src/gates.ts";
import type { CheckRollup, PullRequest, ReviewSummary } from "../src/github.ts";
import type { PrUpdateRecord } from "../src/state.ts";

const basePr: PullRequest = {
  number: 1,
  title: "test",
  authorLogin: "alice",
  headSha: "deadbeef",
  baseRef: "main",
  mergeable: true,
  mergeableState: "behind",
  autoMergeEnabled: true,
  updatedAt: "2026-05-09T10:00:00Z",
};
const baseReviews: ReviewSummary = { approvalsByLatest: 1, changesRequestedByLatest: 0 };
const baseChecks: CheckRollup = { hasFailing: false, inProgress: 0, total: 3 };

describe("approved", () => {
  it("passes with at least one approval and no changes requested", () => {
    expect(approved({ approvalsByLatest: 1, changesRequestedByLatest: 0 }).pass).toBe(true);
  });
  it("fails when changes are requested even if approvals exist", () => {
    expect(approved({ approvalsByLatest: 2, changesRequestedByLatest: 1 }).pass).toBe(false);
  });
  it("fails with no approvals", () => {
    expect(approved({ approvalsByLatest: 0, changesRequestedByLatest: 0 }).pass).toBe(false);
  });
});

describe("autoMergeOn", () => {
  it("passes when auto-merge is enabled", () => {
    expect(autoMergeOn(basePr).pass).toBe(true);
  });
  it("fails when auto-merge is disabled", () => {
    expect(autoMergeOn({ ...basePr, autoMergeEnabled: false }).pass).toBe(false);
  });
});

describe("mergeableKnown", () => {
  it("passes when mergeable is true", () => {
    expect(mergeableKnown(basePr).pass).toBe(true);
  });
  it("passes when mergeable is false (known, just not mergeable)", () => {
    expect(mergeableKnown({ ...basePr, mergeable: false }).pass).toBe(true);
  });
  it("fails when mergeable is null (still computing)", () => {
    expect(mergeableKnown({ ...basePr, mergeable: null }).pass).toBe(false);
  });
});

describe("behindMain", () => {
  it("passes only when mergeable_state is 'behind'", () => {
    expect(behindMain(basePr).pass).toBe(true);
  });
  it("fails for 'clean' (already up-to-date)", () => {
    expect(behindMain({ ...basePr, mergeableState: "clean" }).pass).toBe(false);
  });
  it("fails for 'dirty' (real conflict)", () => {
    expect(behindMain({ ...basePr, mergeableState: "dirty" }).pass).toBe(false);
  });
  it("fails for 'blocked'", () => {
    expect(behindMain({ ...basePr, mergeableState: "blocked" }).pass).toBe(false);
  });
});

describe("ciNotRed", () => {
  it("passes when nothing is failing", () => {
    expect(ciNotRed(baseChecks).pass).toBe(true);
  });
  it("fails when any check is failing", () => {
    expect(ciNotRed({ ...baseChecks, hasFailing: true }).pass).toBe(false);
  });
});

describe("ciSettled", () => {
  it("passes unconditionally when waitForCi is false (default behavior)", () => {
    expect(ciSettled({ hasFailing: false, inProgress: 5, total: 10 }, false).pass).toBe(true);
  });
  it("passes when waitForCi is true and nothing is in progress", () => {
    expect(ciSettled({ hasFailing: false, inProgress: 0, total: 3 }, true).pass).toBe(true);
  });
  it("fails when waitForCi is true and checks are in progress", () => {
    const r = ciSettled({ hasFailing: false, inProgress: 2, total: 5 }, true);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe("2 checks in progress");
  });
  it("passes when waitForCi=true with no checks at all", () => {
    expect(ciSettled({ hasFailing: false, inProgress: 0, total: 0 }, true).pass).toBe(true);
  });
});

describe("cooldown", () => {
  const now = new Date("2026-05-09T12:00:00Z");
  it("passes when no record exists", () => {
    expect(cooldown(undefined, 15, now).pass).toBe(true);
  });
  it("fails when last update is within window", () => {
    const rec: PrUpdateRecord = {
      lastUpdatedAt: "2026-05-09T11:50:00Z",
      resultingSha: "abc",
    };
    expect(cooldown(rec, 15, now).pass).toBe(false);
  });
  it("passes when last update is older than window", () => {
    const rec: PrUpdateRecord = {
      lastUpdatedAt: "2026-05-09T11:30:00Z",
      resultingSha: "abc",
    };
    expect(cooldown(rec, 15, now).pass).toBe(true);
  });
  it("passes when record timestamp is malformed", () => {
    const rec: PrUpdateRecord = { lastUpdatedAt: "garbage", resultingSha: "abc" };
    expect(cooldown(rec, 15, now).pass).toBe(true);
  });
});

describe("evaluateAll", () => {
  const now = new Date("2026-05-09T12:00:00Z");
  it("allPass=true when every gate passes", () => {
    const out = evaluateAll({
      pr: basePr,
      reviews: baseReviews,
      checks: baseChecks,
      record: undefined,
      cooldownMinutes: 15,
      waitForCi: false,
      now,
    });
    expect(out.allPass).toBe(true);
  });
  it("allPass=false if any gate fails", () => {
    const out = evaluateAll({
      pr: { ...basePr, autoMergeEnabled: false },
      reviews: baseReviews,
      checks: baseChecks,
      record: undefined,
      cooldownMinutes: 15,
      waitForCi: false,
      now,
    });
    expect(out.allPass).toBe(false);
    expect(out.results.auto_merge_on.pass).toBe(false);
  });
  it("reports failed gate reason", () => {
    const out = evaluateAll({
      pr: { ...basePr, mergeableState: "clean" },
      reviews: baseReviews,
      checks: baseChecks,
      record: undefined,
      cooldownMinutes: 15,
      waitForCi: false,
      now,
    });
    expect(out.results.behind_main.reason).toBe("mergeable_state=clean");
  });
  it("blocks update when waitForCi=true and CI in progress", () => {
    const out = evaluateAll({
      pr: basePr,
      reviews: baseReviews,
      checks: { hasFailing: false, inProgress: 2, total: 5 },
      record: undefined,
      cooldownMinutes: 15,
      waitForCi: true,
      now,
    });
    expect(out.allPass).toBe(false);
    expect(out.results.ci_settled.pass).toBe(false);
  });
  it("allows update when waitForCi=false even with CI in progress", () => {
    const out = evaluateAll({
      pr: basePr,
      reviews: baseReviews,
      checks: { hasFailing: false, inProgress: 2, total: 5 },
      record: undefined,
      cooldownMinutes: 15,
      waitForCi: false,
      now,
    });
    expect(out.allPass).toBe(true);
    expect(out.results.ci_settled.pass).toBe(true);
  });
});
