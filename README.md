# merge-minion

A small Node/TypeScript daemon that auto-clicks GitHub's "Update branch" button on your PRs when they fall behind `main` — so Auto-merge re-engages and your PR lands without you babysitting it.

It only acts on PRs that are otherwise ready to merge (approved, auto-merge on, no conflicts, CI not red), so it doesn't waste CI cycles on PRs that wouldn't merge anyway.

## How it works

Every 5 minutes (via launchd), the minion:

1. Calls `gh auth token` to get your GitHub credentials (no PAT needed).
2. Lists your open PRs in each configured repo.
3. For each PR, evaluates these gates:
   - ≥1 approving review
   - Auto-merge enabled
   - `mergeable === true` and `mergeable_state === "behind"`
   - Latest CI on the PR head is not failing
   - Not in cooldown (default 15 min)
4. Picks one "leader" PR per repo (oldest `updated_at`) and calls `PUT /repos/.../pulls/{n}/update-branch`.
5. Records the result in `~/.merge-minion/state.json` for cooldown tracking.

## Prerequisites

- macOS (the launchd plist assumes it; the code itself is OS-agnostic).
- Node 22+.
- `gh` CLI authenticated against the host where your repos live: `gh auth status` should show you logged in.

## Install

```bash
cd /Users/tangent.lin/Development/os/merge-minion
npm install
```

## Configure

Create `~/.merge-minion/config.json`:

```json
{
  "repos": [
    { "slug": "your-org/repo-a" },
    { "slug": "your-org/repo-b", "updateMethod": "rebase" },
    { "slug": "your-org/repo-c", "waitForCi": true }
  ],
  "cooldownMinutes": 15,
  "dryRun": false
}
```

- `slug` — `owner/repo` form.
- `updateMethod` — `"merge"` (default) or `"rebase"`. Match the repo's preferred update style.
- `waitForCi` — `false` (default) or `true`. Default behavior assumes the repo has `cancel-in-progress: true` on its CI workflows, so updating mid-run cancels the in-flight CI and starts a fresh one. Set to `true` for repos that DON'T cancel — there the minion will wait for in-flight CI to finish before updating, avoiding a duplicate CI cycle.
- `cooldownMinutes` — minimum time between updates of the same PR. Protects against CI thrash.
- `dryRun` — when `true`, the minion logs what it *would* do but makes no API mutations.

## Run manually first

```bash
npm run dry-run
```

Look at the output. Each PR will be logged with which gates passed and which failed. If a PR you expected to be a candidate isn't one, the gate `fail:` reasons tell you why.

When happy:

```bash
npm start
```

## Schedule via launchd

```bash
cp launchd/com.user.merge-minion.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.user.merge-minion.plist
```

Logs go to `~/Library/Logs/merge-minion.log` and `~/Library/Logs/merge-minion.err.log`.

To reload after editing:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.merge-minion.plist
launchctl load   ~/Library/LaunchAgents/com.user.merge-minion.plist
```

To stop:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.merge-minion.plist
```

> The plist hardcodes `/Users/tangent.lin/...` paths. Edit if you fork.

## Verify end-to-end

1. **Auth sanity** — `gh auth status` shows logged in; `gh auth token | head -c 8` prints something.
2. **Dry-run** — `npm run dry-run` lists your PRs with gate decisions; no API mutations.
3. **Controlled real run** — open a tiny test PR in a sandbox repo, get an approval, enable auto-merge, push to `main` so the PR is "behind", run `npm start` once, check the GitHub UI.
4. **Cooldown** — run `npm start` twice back-to-back on the same PR; second tick should log `cooldown: fail:in cooldown`.
5. **launchd** — `launchctl load`, wait 5 minutes, check `~/Library/Logs/merge-minion.log`.

## Pitfalls handled

- **Stale `mergeable`** — when GitHub returns `null`, we skip the tick rather than poll inside it.
- **Dismiss-stale-reviews branch protection** — if the PR's base branch dismisses approvals on push, an update would *cause* the merge gate to fail. The minion checks branch protection and skips those repos with a warning.
- **CI cost guard** — the cooldown prevents thrashing when main moves frequently or CI flaps.
- **Leader PR per repo** — at most one PR is updated per repo per tick to avoid serial wasted CI.

## Pitfalls *not* handled (deferred)

- Conflicts (`mergeable_state === "dirty"`) — the minion skips; you fix manually.
- Required signed commits by the author — `update-branch` produces a GitHub-signed merge commit; if the repo rejects it, the API will return 422 and the minion logs and moves on. You'll need to update via local rebase + signed push for those repos.
- GitHub App auth path (for cloud/laptop-closed scheduling) — see plan if you want to extend.

## On SSH

Not used. The whole loop is server-side via the GitHub REST API. SSH stays as a fallback path for cases the API can't handle (e.g., custom rebase resolution), but that's out of scope.
