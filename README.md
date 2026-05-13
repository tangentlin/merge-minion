# merge-minion

A small Node/TypeScript daemon that auto-clicks GitHub's "Update branch" button on your PRs when they fall behind `main` — so Auto-merge re-engages and your PR lands without you babysitting it.

It only acts on PRs that are otherwise ready to merge (approved, auto-merge on, no conflicts, CI not red), so it doesn't waste CI cycles on PRs that wouldn't merge anyway.

## Quickstart

Five steps from clone to a daemon running under launchd. macOS, Node 22+, and the [`gh` CLI](https://cli.github.com/) are required.

### 1. Verify prerequisites

```bash
gh auth status   # should print "Logged in to github.com as <you>"
node --version   # should be v22.x or newer
```

### 2. Clone and install

```bash
git clone https://github.com/<your-fork>/merge-minion.git
cd merge-minion
npm install
```

### 3. Create a minimal config

```bash
mkdir -p ~/.merge-minion
cat > ~/.merge-minion/config.json <<'EOF'
{
  "repos": [
    { "slug": "your-org/your-repo" }
  ]
}
EOF
```

That's the smallest valid config. See [Configuration](#configuration) for the rest of the knobs.

### 4. Verify with a dry run

No API mutations — just gate evaluation against your real PRs:

```bash
npm run dry-run
```

Each open PR you authored gets one log line summarizing the gate decisions:

```text
20:14:35 INFO  tick.start viewer=jane repos=1 dryRun=true
20:14:36 INFO  pr.evaluated repo=your-org/your-repo pr=147 headSha=a1b2c3d candidate=false
               gates: ✓ review  ✓ auto_merge  ✓ mergeable  ✗ behind (not behind)  ✓ ci  ✓ cooldown
20:14:36 INFO  tick.end
```

`candidate=true` means all gates passed and that PR would have been updated. If a PR you expected to be a candidate isn't one, the `✗ gate (reason)` tells you why.

### 5. Schedule it under launchd

Point the bundled plist at your local checkout, then load it:

```bash
sed -i '' \
  -e "s|/Users/tangent.lin/Development/os/merge-minion|$PWD|g" \
  -e "s|/Users/tangent.lin|$HOME|g" \
  launchd/com.user.merge-minion.plist
npm run daemon:load
```

Confirm:

```bash
launchctl list | grep merge-minion         # should show a PID
tail -f ~/Library/Logs/merge-minion.log    # tick.start every 5 min
```

That's it — the minion now keeps your eligible PRs current with `main` and will restart itself on crash or reboot. Stop it with `npm run daemon:unload`.

> **Forking note**: the `sed` step modifies the tracked plist. If you commit and push, your fork will carry your local paths. Either keep that change local (e.g., `git update-index --assume-unchanged launchd/com.user.merge-minion.plist`) or templatize the plist in your fork.

## How it works

By default the minion runs as a long-running process and ticks every `tickIntervalSeconds` (default 300). On each tick, it:

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

Pass `--once` to run a single tick and exit. Under launchd it stays running, and `KeepAlive` respawns it if it ever crashes.

## Configuration

Full schema for `~/.merge-minion/config.json`:

```json
{
  "repos": [
    { "slug": "your-org/repo-a" },
    { "slug": "your-org/repo-b", "updateMethod": "rebase" },
    { "slug": "your-org/repo-c", "waitForCi": true }
  ],
  "cooldownMinutes": 15,
  "tickIntervalSeconds": 300,
  "dryRun": false
}
```

| Field                  | Default      | Purpose                                                                                                                                                                                                                                                               |
| ---------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repos[].slug`         | *(required)* | `owner/repo` form.                                                                                                                                                                                                                                                    |
| `repos[].updateMethod` | `"merge"`    | `"merge"` or `"rebase"`. Match the repo's preferred update style.                                                                                                                                                                                                     |
| `repos[].waitForCi`    | `false`      | If `false` (default), assumes the repo's CI uses `cancel-in-progress: true` so updating mid-run cancels the in-flight CI. Set to `true` for repos that DON'T cancel — the minion will wait for in-flight CI to finish before updating, avoiding a duplicate CI cycle. |
| `cooldownMinutes`      | `15`         | Minimum time between updates of the same PR. Protects against CI thrash.                                                                                                                                                                                              |
| `tickIntervalSeconds`  | `300`        | Seconds between ticks when running as a daemon. Override per-run with `--interval-seconds N`. Ignored when `--once` is passed.                                                                                                                                        |
| `dryRun`               | `false`      | When `true`, the minion logs what it *would* do but makes no API mutations.                                                                                                                                                                                           |

## Commands

| Command                 | Effect                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `npm start`             | Run the daemon in the foreground (loops every `tickIntervalSeconds`; Ctrl-C exits cleanly between ticks). |
| `npm run dry-run`       | Single tick with no API mutations; print gate decisions and exit.                                         |
| `npm run daemon:load`   | Copy the plist into `~/Library/LaunchAgents/` and load it.                                                |
| `npm run daemon:unload` | Stop the launchd agent.                                                                                   |
| `npm run daemon:reload` | Reload the launchd agent (after editing the plist or source).                                             |
| `npm test`              | Run the vitest suite.                                                                                     |
| `npm run typecheck`     | Type-check without emitting.                                                                              |

CLI flags (use via `npx tsx src/index.ts <flags>`):

- `--once` — single tick and exit (default is loop)
- `--interval-seconds N` — override `tickIntervalSeconds` for this run
- `--dry-run` — no API mutations
- `--log-format pretty|json` — override the auto-detected format
- `--verbose` / `-v` — enable debug logs
- `--config <path>` / `--state <path>` — override default file locations
- `--help` — full usage

## Logging

Output is **pretty** (colored, key=value, ✓/✗ for gate results) when stdout is a TTY and **JSON** otherwise — interactive runs are readable, and the launchd log file stays grep/`jq`-friendly.

Override with `--log-format pretty|json` or the `LOG_FORMAT` env var. To make the launchd-written log file pretty (e.g., if you `tail -f` it directly), add `LOG_FORMAT=pretty` to the plist's `EnvironmentVariables` and `npm run daemon:reload`.

## Verify end-to-end

1. **Auth** — `gh auth status` shows logged in; `gh auth token | head -c 8` prints something.
2. **Dry run** — `npm run dry-run` lists your PRs with gate decisions; no API mutations.
3. **Controlled real run** — open a tiny test PR in a sandbox repo, get an approval, enable auto-merge, push to `main` so the PR is "behind", run `npx tsx src/index.ts --once`, check the GitHub UI.
4. **Cooldown** — run the same `--once` twice back-to-back on the same PR; the second tick should log `✗ cooldown (in cooldown)`.
5. **launchd** — `npm run daemon:load`, then `launchctl list | grep merge-minion` should show a PID. `~/Library/Logs/merge-minion.log` will contain `loop.start` immediately and a second `tick.start` after `tickIntervalSeconds`.

## Pitfalls handled

- **Stale `mergeable`** — when GitHub returns `null`, we skip the tick rather than poll inside it.
- **Dismiss-stale-reviews branch protection** — if the PR's base branch dismisses approvals on push, an update would *cause* the merge gate to fail. The minion checks branch protection and skips those repos with a warning.
- **CI cost guard** — the cooldown prevents thrashing when `main` moves frequently or CI flaps.
- **Leader PR per repo** — at most one PR is updated per repo per tick to avoid serial wasted CI.

## Pitfalls *not* handled (deferred)

- Conflicts (`mergeable_state === "dirty"`) — the minion skips; you fix manually.
- Required signed commits by the author — `update-branch` produces a GitHub-signed merge commit; if the repo rejects it, the API will return 422 and the minion logs and moves on. You'll need to update via local rebase + signed push for those repos.
- GitHub App auth path (for cloud / laptop-closed scheduling) — out of scope.

## On SSH

Not used. The whole loop is server-side via the GitHub REST API. SSH stays as a fallback path for cases the API can't handle (e.g., custom rebase resolution), but that's out of scope.
