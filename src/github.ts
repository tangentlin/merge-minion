import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import type { UpdateMethod } from "./config.ts";

const execFileAsync = promisify(execFile);

export interface PullRequest {
  number: number;
  title: string;
  authorLogin: string;
  headSha: string;
  baseRef: string;
  mergeable: boolean | null;
  mergeableState: string;
  autoMergeEnabled: boolean;
  updatedAt: string;
}

export interface ReviewSummary {
  approvalsByLatest: number;
  changesRequestedByLatest: number;
}

export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "stale"
  | "skipped"
  | null;

export interface CheckRollup {
  hasFailing: boolean;
  inProgress: number;
  total: number;
}

export interface BranchProtectionInfo {
  dismissStaleReviews: boolean;
}

export class GitHubClient {
  private constructor(
    private octokit: Octokit,
    public readonly viewerLogin: string,
  ) {}

  static async create(): Promise<GitHubClient> {
    const token = await getGhToken();
    const octokit = new Octokit({ auth: token, userAgent: "merge-minion/0.1" });
    const { data } = await octokit.users.getAuthenticated();
    return new GitHubClient(octokit, data.login);
  }

  async listOpenPrsAuthoredByViewer(repoSlug: string): Promise<PullRequest[]> {
    const [owner, repo] = repoSlug.split("/");
    if (!owner || !repo) throw new Error(`bad slug: ${repoSlug}`);

    const list = await this.octokit.paginate(this.octokit.pulls.list, {
      owner,
      repo,
      state: "open",
      per_page: 100,
    });

    const mine = list.filter((p) => p.user?.login === this.viewerLogin);

    const detailed: PullRequest[] = [];
    for (const summary of mine) {
      const { data } = await this.octokit.pulls.get({
        owner,
        repo,
        pull_number: summary.number,
      });
      detailed.push({
        number: data.number,
        title: data.title,
        authorLogin: data.user?.login ?? "",
        headSha: data.head.sha,
        baseRef: data.base.ref,
        mergeable: data.mergeable,
        mergeableState: data.mergeable_state,
        autoMergeEnabled: data.auto_merge != null,
        updatedAt: data.updated_at,
      });
    }
    return detailed;
  }

  async getReviewSummary(repoSlug: string, prNumber: number): Promise<ReviewSummary> {
    const [owner, repo] = repoSlug.split("/");
    if (!owner || !repo) throw new Error(`bad slug: ${repoSlug}`);
    const reviews = await this.octokit.paginate(this.octokit.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    const latestByUser = new Map<string, string>();
    for (const r of reviews) {
      const login = r.user?.login;
      if (!login) continue;
      if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED") {
        latestByUser.set(login, r.state);
      }
    }
    let approvals = 0;
    let changes = 0;
    for (const state of latestByUser.values()) {
      if (state === "APPROVED") approvals++;
      else if (state === "CHANGES_REQUESTED") changes++;
    }
    return { approvalsByLatest: approvals, changesRequestedByLatest: changes };
  }

  async getCheckRollup(repoSlug: string, sha: string): Promise<CheckRollup> {
    const [owner, repo] = repoSlug.split("/");
    if (!owner || !repo) throw new Error(`bad slug: ${repoSlug}`);
    const runs = await this.octokit.paginate(this.octokit.checks.listForRef, {
      owner,
      repo,
      ref: sha,
      per_page: 100,
    });
    let hasFailing = false;
    let inProgress = 0;
    for (const run of runs) {
      if (run.status !== "completed") {
        inProgress++;
        continue;
      }
      const c = run.conclusion as CheckConclusion;
      if (c === "failure" || c === "timed_out" || c === "action_required" || c === "cancelled") {
        hasFailing = true;
      }
    }
    return { hasFailing, inProgress, total: runs.length };
  }

  async getBranchProtection(
    repoSlug: string,
    branch: string,
  ): Promise<BranchProtectionInfo | null> {
    const [owner, repo] = repoSlug.split("/");
    if (!owner || !repo) throw new Error(`bad slug: ${repoSlug}`);
    try {
      const { data } = await this.octokit.repos.getBranchProtection({
        owner,
        repo,
        branch,
      });
      return {
        dismissStaleReviews:
          data.required_pull_request_reviews?.dismiss_stale_reviews === true,
      };
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 403) return null;
      throw err;
    }
  }

  async updateBranch(
    repoSlug: string,
    prNumber: number,
    expectedHeadSha: string,
    method: UpdateMethod = "merge",
  ): Promise<{ newHeadSha: string | null }> {
    const [owner, repo] = repoSlug.split("/");
    if (!owner || !repo) throw new Error(`bad slug: ${repoSlug}`);
    const { data } = await this.octokit.request(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch",
      {
        owner,
        repo,
        pull_number: prNumber,
        expected_head_sha: expectedHeadSha,
        update_method: method,
      },
    );
    return { newHeadSha: (data as { head?: { sha?: string } } | undefined)?.head?.sha ?? null };
  }
}

async function getGhToken(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"]);
    const token = stdout.trim();
    if (!token) throw new Error("`gh auth token` returned empty");
    return token;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error("`gh` CLI not found. Install: https://cli.github.com");
    }
    throw new Error(`failed to get gh auth token: ${(err as Error).message}`);
  }
}
