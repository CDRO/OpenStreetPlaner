---
name: deploio-manage
description: Day-to-day operations on a running Deploio app — config changes, routine log monitoring, console/exec access, and redeployments. This skill should be triggered for: "change env vars", "scale app", "add worker", "cron job", "scheduled job", "custom domain", "retry build", "deploy new version", "tail logs", "show me the logs", "open rails console", "run a rake task", "exec into app", "run a command in the app", "health probe", "basic auth", "check app status", "what apps do I have", "rollback deploy", "restart app", "previous version", "revert to last working". Do NOT use for first-time app creation (use deploio-deploy), diagnosing a crash or error (use deploio-debug), or provisioning databases/storage (use deploio-provision).
license: MIT
metadata:
  version: 1.5.0
---

# Deploio: Managing a Running App

Your role is coordinator. You never run commands yourself — you spawn `deploio-cli` agents with `mode: bypassPermissions` for all execution. Identify the operation, inspect current state if needed, confirm impactful changes, then execute.

**Communication style:** Speak to the user in plain language — describe what you'll do, never show raw nctl commands. Say "I'll add the Sidekiq worker to your app" not "I'll run `nctl update app ... --worker-job-name=sidekiq`". Agents manage the CLI entirely on the user's behalf.

---

## Phase 0: Identify operation from context

**Autoinfer app and project before asking.** Run:
```bash
git remote get-url origin   # https://github.com/acme/myapp → repo name only (not the org)
  nctl auth whoami             # → active organization (marked with *)
git branch --show-current   # main → app=main
```
Derive: `app = <branch>` (e.g. `main`), `org` from the `*`-marked entry in `nctl auth whoami` (not the git URL), `project = <org>-<repo>` (e.g. `renuotest-myapp` — never just `<repo>`; nctl errors).

State your inference inline: *"Using app `main` in project `renuotest-myapp` (org `renuotest`) — let me know if that's different."* Proceed immediately. Only ask explicitly if there is no git remote configured, or if a subsequent nctl command fails because the organization doesn't exist.

From the conversation, also determine:
- **Operation** — from the table below

| User says | Operation | Go to |
|---|---|---|
| "show logs", "tail logs", "what do the logs say" | `logs-app` | → Logs |
| "build logs", "watch the build" | `logs-build` | → Logs |
| "rails console", "rails c", "open a shell", "run a command", "exec", "rake task" | `exec` | → Exec |
| "list apps", "what apps do I have", "check status", "is it running", "resource usage" | `inspect` | → Inspect |
| "basic auth credentials", "get the password" | `basic-auth-credentials` | → Inspect |
| "deploy new version", "change branch", "redeploy" | `git-revision` | → Execute |
| "retry build", "force rebuild" | `retry-build` | → Execute |
| "re-deploy", "retry release" | `retry-release` | → Execute |
| "add / change env var" | `env` | → Execute |
| "change build env", "change Ruby version", "change Node version" | `build-env` | → Execute |
| "scale", "more replicas" | `replicas` | → Execute |
| "upsize", "change size" | `size` | → Execute |
| "custom domain", "add host" | `hosts` | → Execute |
| "health check", "health probe" | `health-probe` | → Execute |
| "enable basic auth", "disable basic auth" | `basic-auth` | → Execute |
| "add worker", "Sidekiq", "good_job" | `worker-job` | → Execute |
| "remove worker", "delete worker" | `delete-worker-job` | → Execute |
| "add scheduled job", "add cron", "scheduled task" | `scheduled-job` | → Execute |
| "remove scheduled job", "remove cron" | `delete-scheduled-job` | → Execute |
| "run migrations on deploy", "deploy job" | `deploy-job` | → Execute |
| "disable deploy job", "remove deploy job" | `delete-deploy-job` | → Execute |
| "move repo", "change git URL" | `git-url` | → Execute |
| "rollback", "previous version", "revert deploy", "go back to last working" | `rollback` | → Execute |
| "restart app", "restart the app" | `restart` | → Execute |
| "pause app", "stop billing", "hibernate" | `pause` | → Execute |
| "resume app", "unpause", "start app" | `resume` | → Execute |
| "copy app", "duplicate app", "clone app" | `copy` | → Execute |

**For rollback:** explain the mechanism in plain terms: "I'll pull your release history, show you the available versions, then redeploy the one you choose."

---

## Logs

Routine log monitoring during operations. No confirmation needed — read-only.

Spawn the `deploio-cli` agent with `mode: bypassPermissions`:

```
task: logs
app: <app-name>
project: <project>
type: app | worker_job | deploy_job | scheduled_job  # "build" uses nctl logs build, not --type
follow: true | false
lines: <n>
since: <duration>  # format: 1s | 1m | 1h | 48h
```

### App logs

Log types for `--type`: `app` (default runtime output), `worker_job`, `deploy_job`, `scheduled_job`. Build logs use a separate `nctl logs build` command (see below).

```bash
# Follow live (most common)
nctl logs app <name> --project <project> -f

# Last N lines
nctl logs app <name> --project <project> -l 500

# Go back in time (1s, 1m, 1h, 48h)
nctl logs app <name> --project <project> -s 2h

# By type
nctl logs app <name> --project <project> -f --type worker_job
nctl logs app <name> --project <project> -f --type deploy_job
nctl logs app <name> --project <project> -f --type scheduled_job

# Clean output without metadata labels
nctl logs app <name> --project <project> -f --no-labels
```

### Build logs

Build logs live under `nctl logs build`, not `nctl logs app --type build`.

```bash
# Latest build for an app (-a = latest build for this app name)
nctl logs build <app-name> --project <project> -a
nctl logs build <app-name> --project <project> -a -l 5000

# Specific build by name
nctl get builds --project <project>               # find the build name
nctl logs build <build-name> --project <project>
nctl logs build <build-name> --project <project> -f
nctl logs build <build-name> --project <project> -l 5000
```

> Use `nctl logs build -a` when the user says "show me the build logs" — it fetches the latest automatically without needing to know the build name.

---

## Exec

Run commands or open a shell inside a running app container. Routine operational use — Rails console, rake tasks, env inspection. For *diagnosing a crash or error*, use deploio-debug instead.

Always ask before running anything destructive (`db:reset`, `db:drop`, `db:seed:replant`).

Spawn the `deploio-cli` agent with `mode: bypassPermissions`:

```
task: exec
app: <app-name>
project: <project>
command: <command>
```

The agent runs `nctl exec app <name> --project <project> -- <command>`.

> **Database connections:** When the user wants to connect to the database, the exec agent should:
> 1. Attempt `rails dbconsole` (or `psql`) inside the container
> 2. If the connection is refused due to an IP restriction, automatically:
>    - Retrieve the user's current IP: `curl -s https://api.ipify.org`
>    - Find the database name from the app's `DATABASE_URL` env var
>    - Add the IP to the allowlist: `nctl update postgresdatabase <db-name> --allowed-cidrs=<ip>/32`
>    - Retry the connection
> 3. Report the outcome in plain terms — no nctl syntax in the user-facing message

### Common patterns

```bash
# Rails console (most common)
nctl exec app <name> --project <project> -- bundle exec rails console
nctl exec app <name> --project <project> -- bin/rails c
nctl exec app <name> --project <project> -- rails c

# Interactive shell
nctl exec app <name> --project <project> -- bash

# Rails runner (non-interactive, good for quick queries)
nctl exec app <name> --project <project> -- bundle exec rails runner "puts User.count"
nctl exec app <name> --project <project> -- bundle exec rails runner "puts User.find(42).inspect"

# Rake tasks
nctl exec app <name> --project <project> -- bundle exec rake db:version
nctl exec app <name> --project <project> -- bundle exec rake db:seed
nctl exec app <name> --project <project> -- bundle exec rails db:seed:replant

# Check env vars
nctl exec app <name> --project <project> -- env | grep DATABASE
nctl exec app <name> --project <project> -- env | grep REDIS

# Destructive — always confirm explicitly before running
nctl exec app <name> --project <project> -- DISABLE_DATABASE_ENVIRONMENT_CHECK=1 bundle exec rails db:seed:replant
```

> `exec` connects to the **first available replica**. In multi-replica setups, use logs to correlate which replica is relevant.

---

## Inspect

Read-only checks. No confirmation needed.

Spawn the `deploio-cli` agent with `mode: bypassPermissions`:

```
task: inspect
app: <app-name>   # optional for list-apps
project: <project>
view: summary | yaml | stats | dns | basic-auth-credentials
```

```bash
# Status + URL
nctl get app <name> --project <project>

# Full config (env var keys, hosts, workers, jobs)
nctl get app <name> --project <project> -o yaml

# Check a specific env var value
nctl get app <name> --project <project> -o yaml | grep DATABASE_URL

# CPU, memory, restart counts per replica
# Columns: REPLICA, STATUS, CPU (millicores), CPU%, MEMORY (MiB), MEMORY%, RESTARTS, LASTEXITCODE
# Exit code 137 = OOM or storage limit exceeded
nctl get app <name> --project <project> -o stats

# DNS records for custom domain setup
nctl get app <name> --project <project> --dns

# Basic auth username + password
nctl get app <name> --project <project> --basic-auth-credentials

# All apps in a project
nctl get apps --project <project>

# All apps across every project (with stats)
nctl get apps -A
nctl get apps -A -o stats
```

---

## Phase 1: Inspect before changes

For update operations, inspect current state first to detect conflicts.

```
task: inspect
app: <app-name>
project: <project>
view: yaml
```

Returns:
```json
{
  "status": "Running | Pending | Failed",
  "current_revision": "main",
  "current_size": "mini",
  "replicas": 1,
  "env_var_keys": ["RAILS_ENV", "DATABASE_URL"],
  "hosts": ["myapp.deploio.app"],
  "workers": [{ "name": "sidekiq", "command": "bundle exec sidekiq", "size": "mini" }],
  "scheduled_jobs": [],
  "deploy_job": null,
  "health_probe_path": null,
  "basic_auth_enabled": false
}
```

---

## Phase 2: Confirm before executing

Use `AskUserQuestion` for any impactful operation (env var changes, scaling, size changes, rollbacks, worker/job mutations). Show the current → new value diff before asking:

**Env var change:**
```
Updating myapp:

| Variable | Current | New |
|---|---|---|
| RAILS_ENV | production | production (unchanged) |
| DATABASE_URL | *not set* | postgres://... |
```

```
question: "Apply this change?"
options:
  - "Yes, proceed"
  - "No, cancel"
```

**Scale / size change:**
```
Scaling myapp:

| Setting | Current | New |
|---|---|---|
| Replicas | 1 | 3 |
| Size | mini | standard-1 (billing impact) |
```

```
question: "Apply this change?"
options:
  - "Yes, proceed"
  - "No, cancel"
```

- **Retry build / retry release** — no confirmation needed.
- **Logs / exec / inspect** — no confirmation needed.
- **Destructive exec** (`db:reset`, `db:seed:replant`) — always use `AskUserQuestion` with an explicit "Yes, I understand this is destructive" option.

If the user says "No, cancel" — do not spawn the executor.

---

## Phase 3: Execute

Spawn the `deploio-cli` agent with `mode: bypassPermissions`:

```
task: update
app: <app-name>
project: <project>
operation: <operation>
values: <values>
```

### nctl commands by operation

**Deploy new version / change branch:**
```bash
nctl update app <name> --project <project> --git-revision=<branch|tag|sha>
# Pin to exact local commit:
nctl update app <name> --project <project> --git-revision=$(git rev-parse <branch>)
```

**Force rebuild** (after dependency changes or build env change):
```bash
nctl update app <name> --project <project> --retry-build
```

**Re-deploy existing build** (skip rebuild, re-run release):
```bash
nctl update app <name> --project <project> --retry-release
```
- `--retry-release`: migration failed transiently, config-only change, transient infra issue
- `--retry-build`: build failed, dependency changed, build-time env var changed

**Add / update runtime env vars** (additive — other keys untouched):
```bash
nctl update app <name> --project <project> \
  --env=KEY1=VALUE1 \
  --env=KEY2=VALUE2
```

**Add / update build-time env vars** (triggers a rebuild):
```bash
nctl update app <name> --project <project> \
  --build-env=RUBY_VERSION=3.3.3 \
  --build-env=NODE_VERSION=20
```

**Scale replicas:**
```bash
nctl update app <name> --project <project> --replicas=<n>
```

**Change instance size** (`micro` | `mini` | `standard-1` | `standard-2`):
```bash
nctl update app <name> --project <project> --size=<size>
```

**Add / update custom hostname:**
```bash
nctl update app <name> --project <project> --hosts=myapp.example.com,www.myapp.example.com
# Get DNS records to configure at the registrar:
nctl get app <name> --project <project> --dns
```

**Configure health probe** (Rails default is `/up`):
```bash
nctl update app <name> --project <project> \
  --health-probe-path="/up" \
  --health-probe-period-seconds=5
```

**Toggle basic auth** (HTTP basic auth in front of the app):
```bash
nctl update app <name> --project <project> --basic-auth=true
nctl update app <name> --project <project> --basic-auth=false
# Retrieve the generated credentials after enabling:
nctl get app <name> --project <project> --basic-auth-credentials
```

**Add / update background worker** (Sidekiq, GoodJob, etc.), up to 3 per app:
```bash
nctl update app <name> --project <project> \
  --worker-job-name=sidekiq \
  --worker-job-command="bundle exec sidekiq" \
  --worker-job-size=mini

# GoodJob:
nctl update app <name> --project <project> \
  --worker-job-name=good-job \
  --worker-job-command="bundle exec good_job start" \
  --worker-job-size=mini
```

**Remove a worker:**
```bash
nctl update app <name> --project <project> --delete-worker-job=<worker-name>
```

**Add / update scheduled job** (Deploio's term for time-triggered jobs — not "cron jobs"):
```bash
nctl update app <name> --project <project> \
  --scheduled-job-name=cleanup \
  --scheduled-job-command="rake cleanup:old_records" \
  --scheduled-job-schedule="0 2 * * *" \
  --scheduled-job-size=micro
```

**Remove a scheduled job:**
```bash
nctl update app <name> --project <project> --delete-scheduled-job=<job-name>
```

**Add / update deploy job** (runs before each release; default timeout 5m, max 30m; default retries 3, max 5):
```bash
nctl update app <name> --project <project> \
  --deploy-job-command="bundle exec rake db:prepare" \
  --deploy-job-name="migrate-database" \
  --deploy-job-timeout=10m \
  --deploy-job-retries=1
```

**Rollback to a previous version:**
```bash
# Find the last working git SHA from release history
nctl get releases <name> --project <project>

# Pin to the SHA of the last working release
nctl update app <name> --project <project> --git-revision=<sha>
```

> A rollback is just a redeploy to an earlier commit. Show the release history from Phase 1 inspect output and ask the user which release to roll back to.

**Restart the app** (re-deploy existing build without changes):
```bash
nctl update app <name> --project <project> --retry-release
```

**Remove a deploy job:**
```bash
nctl update app <name> --project <project> --delete-deploy-job=<job-name>
```
> If `--delete-deploy-job` is not accepted by your version of nctl, use `nctl edit app <name> --project <project>` and remove the `deployJob` field from the YAML.

**Rotate SSH deploy key:**
```bash
nctl update app <name> --project <project> \
  --git-ssh-private-key-from-file=<path-to-key>
```

**Move repo / change git URL:**
```bash
nctl update app <name> --project <project> --git-url=https://github.com/neworg/repo
```

**Pause app** (scales to 0 replicas — stops billing; app URL returns 503 while paused):
```bash
nctl update app <name> --project <project> --replicas=0
```

**Resume / unpause app:**
```bash
nctl update app <name> --project <project> --replicas=1
```

**Copy / duplicate app** (starts paused by default, allowing review before activation):
```bash
# Copy within same project
nctl copy application <name> --target-name=<new-name>

# Copy to a different project
nctl copy application <name> --target-name=<new-name> --target-project=<project>

# Copy and start immediately
nctl copy application <name> --target-name=<new-name> --start

# Copy and include custom hosts (must be re-verified on new app)
nctl copy application <name> --target-name=<new-name> --copy-hosts
```

The executor reports back:
- `{ "status": "triggered" }` — command accepted, release in progress
- `{ "status": "failed", "error": "<nctl output>" }` — command rejected

---

## Phase 4: Watch the release

> **App `Ready=True` ≠ latest build succeeded.** Deploio may attempt a rebuild against git HEAD on *any* update, including env-only changes. The app can stay Running on a prior successful build while the newest build fails silently. Always check `nctl get builds` after a release — even config-only ones — and verify the live release is pinned to the newest build.

Create a task with `TaskCreate` when the release starts:

```
title: "Deploying <app-name>"
status: in_progress
```

After the executor confirms, spawn a **monitor agent** with `mode: bypassPermissions`:

```
task: watch-release
app: <app-name>
project: <project>
termination: stop ONLY when ALL three hold —
  1. App Ready=True
  2. Latest build status is Succeeded
  3. Live release is pinned to that latest build
Otherwise stop on Failed or after 10 minutes.
```

The monitor polls all three signals every cycle, not just app status:

```bash
nctl get app <name> --project <project> --watch              # app readiness
nctl get builds --project <project> | head                    # latest build status (Succeeded / Failed / Errored)
nctl get releases <name> --project <project> | head           # which build the live release is pinned to
# If deploy job configured:
nctl logs app <name> --project <project> --type deploy_job -f
```

Surface these signals explicitly, not as parentheticals:

- **Latest build failed** — if the most recent entry from `nctl get builds` is Failed/Errored, flag it immediately, regardless of which release is live and regardless of whether the app is Running.
- **Version regression on release name** — if the new release's BUILDNAME numerically precedes the prior release's, report it: *"⚠ New release is on build `<older>`, but the previous release was on build `<newer>`. Platform fell back to an older build — the newer build attempt likely failed."*

Relay meaningful status changes:
> "[30s] Release in progress — running deploy job..."
> "[90s] App is Running ✓ — release pinned to build `<X>`, which succeeded."

On success, call `TaskUpdate` with `status: completed`.
On failure, call `TaskUpdate` with `status: failed`.

The final summary must always include a build-status line in plain language, on top of the HTTP sanity check:

> "App is Running (release `<X>` on build `<Y>`). Latest build attempt: `<Z>` — status: Succeeded/Failed."

On success:
```
Update applied. App is running.

What's next?
  → Tail the logs       — I can follow them for you
  → Open rails console  — I can exec in
  → Debug an issue      — use deploio-debug
  → Add a database      — use deploio-provision
```

On failure, translate the error and suggest a fix using the table below.

---

## Configuration layers

Deploio config flows: **Organization → Project → App** (lower layers override). For the full reference including how to set project-wide defaults, read `skills/deploio-manage/references/config-layers.md`.

---

## Common update issues

| Symptom | Likely cause | Fix |
|---|---|---|
| Update triggers rebuild unexpectedly | Using `--env` for a build-time var | Use `--build-env` for build-time vars, `--env` for runtime only |
| Deploy job not running | `--deploy-job-name` or `--deploy-job-command` missing | Both `--deploy-job-name` and `--deploy-job-command` are required |
| Deploy job times out | Slow migration | Increase `--deploy-job-timeout=15m` |
| App running but new code not live | Revision not changed | Check `nctl get app <name> -o yaml` for current SHA |
| Host not resolving after `--hosts` | DNS not configured | Run `nctl get app <name> --dns` and set CNAME/TXT at registrar |
| Worker not appearing after update | Name conflict | List existing workers with `nctl get app <name> -o yaml` |
| Worker not deleted | Wrong flag used | Use `--delete-worker-job` for workers, `--delete-scheduled-job` for crons |
| Health probe causing restart loop | Wrong path | Rails default is `/up` — verify it returns 200 |
| Scale command accepted but no new replicas | Project quota | Try a smaller size or contact Deploio support |
| `exec` connects to wrong replica | Multi-replica app | `exec` always uses the first available — use logs to correlate |
