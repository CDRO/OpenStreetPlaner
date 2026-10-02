---
name: deploio-debug
description: Diagnoses and fixes Deploio app problems — crashes, build failures, release errors, and runtime errors. This skill should be triggered when something is broken or wrong: "app crashed", "deploy failing", "build error", "release failed", "app not starting", "getting 500 errors", "getting 503 errors", "bad gateway", "migrations failed", "why is my app broken", "something went wrong after deploy", "app keeps restarting", "app is slow", "high memory usage", "OOM", "performance issue". Gathers logs and state automatically, presents a diagnosis, then applies fixes directly. Do NOT use for routine log monitoring or opening a Rails console on a healthy app (use deploio-manage), first-time deployment (use deploio-deploy), or provisioning services (use deploio-provision).
license: MIT
metadata:
  version: 1.4.0
---

# Deploio: Debugging and Troubleshooting

Your role is coordinator. You never run commands yourself — you spawn `deploio-cli` agents with `mode: bypassPermissions` to gather diagnostics and run exec sessions. The goal is to identify the root cause and propose a fix, not just dump logs.

**Communication style:** Speak to the user in plain language — describe what you found and what you'll do, never paste raw nctl commands. Say "I'm pulling the recent logs and release history" not "I'll run `nctl logs app ... -l 200`". Agents manage the CLI entirely on the user's behalf.

**Parallel agents:** When investigating multiple stages at once (e.g. downtime with no clear cause), spawn two or more agents simultaneously — one for build/deploy logs, another for app status and release history. Don't wait for the first to finish before starting the second.

---

## Phase 0: Classify the failure stage

**Autoinfer app and project before asking.** Run:
```bash
git remote get-url origin   # https://github.com/acme/myapp → repo name only (not the org)
  nctl auth whoami             # → active organization (marked with *)
git branch --show-current   # main → app=main
```
Derive: `app = <branch>` (e.g. `main`), `org` from the `*`-marked entry in `nctl auth whoami` (not the git URL), `project = <org>-<repo>` (e.g. `renuotest-myapp` — never just `<repo>`; nctl errors).

State your inference and proceed immediately: *"Investigating app `main` in project `renuotest-myapp` (org `renuotest`) — let me know if that's different."* Only ask if there is no git remote, or if nctl fails because the organization doesn't exist.

**If the app can be inferred, investigate autonomously** — do not wait for the user to describe the symptom. Spawn diagnostic agents to gather logs, status, and release history, then report your findings. The user can always provide more context, but proactive investigation is faster and more useful.

From the conversation, classify the symptom to target the right logs:

| Symptom | Failure stage | Phase 1 target |
|---|---|---|
| Build error, "bundle install failed", "npm error", "Dockerfile error" | Build | `build` logs |
| "migrations failed", "deploy job timed out" | Deploy job | `deploy_job` logs |
| "release stuck", "release failed" | Release | releases + `app` logs |
| App crashes immediately after deploy | Boot | `app` logs |
| App running but returning errors (500, 502, 503) | Runtime | `app` logs + exec |
| Worker not processing, job queue backed up | Worker | `worker_job` logs |

If no symptom is described and the app is unknown, ask: *"What are you seeing — an error message, a crash, or unexpected behaviour?"*

---

## Phase 1: Gather diagnostics

Create a task with `TaskCreate` to track the investigation:

```
title: "Diagnosing <app-name>"
status: in_progress
```

Spawn one or more `deploio-cli` agents with `mode: bypassPermissions`. When the symptom is unclear or spans multiple stages, **spawn two agents in parallel** rather than sequentially:

- **Agent A** — app status, release history, app logs (boot/runtime/release failures)
- **Agent B** — build logs (if build stage is possible)

```
task: diagnose
app: <app-name>
project: <project>
stage: build | deploy_job | release | boot | runtime | worker | all
```

### What the agent runs (by stage)

**build:**
```bash
# Get the latest build's logs directly — -a means "latest build for this app name"
nctl logs build <app-name> --project <project> -a -l 500

# Or fetch by specific build name if known:
nctl get builds --project <project>
nctl logs build <build-name> --project <project> -l 500
```

> Build logs use `nctl logs build`, NOT `nctl logs app --type build`. The valid `--type` values for `nctl logs app` are: `app`, `worker_job`, `deploy_job`, `scheduled_job`.

**deploy_job:**
```bash
nctl logs app <name> --project <project> --type deploy_job -l 200
```

**release / boot:**
```bash
nctl get app <name> --project <project>              # status overview (NAME, STATUS, URL, AGE)
nctl get app <name> --project <project> -o yaml      # full config + release info
nctl get app <name> --project <project> -o stats     # REPLICA, STATUS, CPU, CPU%, MEMORY, MEMORY%, RESTARTS, LASTEXITCODE
nctl get releases <name> --project <project>         # NAME, BUILDNAME, APPLICATION, SIZE, REPLICAS, STATUS, AGE
nctl logs app <name> --project <project> --type app -l 200
```

**runtime:**
```bash
# -o stats columns: REPLICA, STATUS, CPU (millicores), CPU%, MEMORY (MiB), MEMORY%, RESTARTS, LASTEXITCODE
# Exit code 137 = OOM kill (memory quota exceeded or 2GiB ephemeral storage exceeded)
nctl get app <name> --project <project> -o stats
nctl logs app <name> --project <project> --type app -l 200
# For a recent time window:
nctl logs app <name> --project <project> --type app -s 2h
```

**worker:**
```bash
nctl logs app <name> --project <project> --type worker_job -l 200
```

**all:** run all of the above.

### Return schema

```json
{
  "app_status": "Running | Pending | Failed | CrashLoopBackOff",
  "restart_count": 0,
  "last_exit_code": "137 = OOM or storage limit (2GiB) exceeded; 1 = app crash; 0 = clean exit",
  "live_config": {
    "size": "micro",
    "replicas": 1,
    "deploy_job": "bundle exec rake db:prepare",
    "health_probe_path": "/up",
    "env_var_keys": ["RAILS_ENV", "SECRET_KEY_BASE", "DATABASE_URL"]
  },
  "recent_releases": [
    { "name": "rel-abc", "phase": "Failed", "message": "deploy job timed out" }
  ],
  "log_excerpt": "last 20 relevant lines",
  "likely_cause": "free-text summary if obvious — populate this whenever a clear pattern exists, e.g. 'log contains KeyError: SECRET_KEY_BASE → missing env var', 'restart_count > 5 + LASTEXITCODE 137 → OOM → upsize', 'phase: Failed + deploy job logs show timeout → slow migration', 'size: micro + MEMORY% > 90 → near OOM → suggest mini'"
}
```

**Use `live_config` in diagnosis:** cross-reference the live platform config against observed symptoms:
- `size: micro` + `MEMORY% > 80%` or `LASTEXITCODE 137` → OOM → recommend upsizing to `mini`
- `deploy_job` set + deploy job logs empty → deploy job may have been removed from platform but still expected
- `health_probe_path` set but app returning non-200 → health probe causing restart loop
- `env_var_keys` missing expected vars (e.g. `DATABASE_URL` absent for a Rails app) → surface immediately as likely root cause

The `live_config` comes from `nctl get app <name> -o yaml` — this is the authoritative platform state, equivalent to a remote `.deploio.yaml`.

---

## Phase 2: Diagnose and present findings

Read the report and match against the common problems table below. If the error message or pattern is not covered by the table and is not self-explanatory, use `WebSearch` (e.g. `"Deploio <error fragment>"` or `"nctl <error> site:guides.deplo.io"`) or `WebFetch` on relevant Deploio docs pages to look up the specific error before presenting findings.

Present findings in plain language — never dump raw nctl output at the user:

```
Diagnosis for myapp:

| Finding | Detail |
|---|---|
| Status | CrashLoopBackOff (12 restarts) |
| Likely cause | SECRET_KEY_BASE is not set — Rails requires it in production |

From logs:
> KeyError: key not found: SECRET_KEY_BASE

Fix options:
  1. Add the missing env var (I'll do this via deploio-manage)
  2. Exec into the app to investigate further
  3. Pull the build image and debug locally
```

---

## Phase 3: Exec for deeper investigation

When the error is unclear from logs alone — connection failures, unexpected data state, env var values — run a targeted diagnostic command inside the container.

Spawn the `deploio-cli` agent with `mode: bypassPermissions`:

```
task: exec
app: <app-name>
project: <project>
command: <diagnostic command>
```

The agent runs `nctl exec app <name> --project <project> -- <command>`.

### Diagnostic one-liners

```bash
# Check what env vars are actually set at runtime
nctl exec app <name> --project <project> -- env | grep DATABASE
nctl exec app <name> --project <project> -- env | grep REDIS
nctl exec app <name> --project <project> -- env | grep SECRET

# Test connectivity
nctl exec app <name> --project <project> -- curl -s http://localhost:3000/up
nctl exec app <name> --project <project> -- curl -s http://localhost:<port>/healthz

# Rails diagnostic queries
nctl exec app <name> --project <project> -- bundle exec rails runner "puts ActiveRecord::Base.connection.execute('SELECT 1').inspect"
nctl exec app <name> --project <project> -- bundle exec rake db:version
nctl exec app <name> --project <project> -- bundle exec rails runner "puts User.count"

# General container inspection
nctl exec app <name> --project <project> -- env              # all env vars
nctl exec app <name> --project <project> -- cat /etc/hosts   # network config
```

> `exec` connects to the **first available replica**. Use restart counts from `-o stats` to identify which replica is problematic.

---

## Phase 4: Pull build image (build succeeds, release fails)

When the build passes but the app crashes on startup and you can't reproduce it locally.

Before spawning an agent for this, confirm two things with the user:
1. They want to pull the image locally (it may be large)
2. Docker is running on their machine (`docker info` should succeed)

```bash
# Find the build name
nctl get builds --project <project>

# Pull the exact OCI image Deploio built
nctl get build <build-name> --project <project> --pull-image

# Run it locally
docker run --rm -it <image> bash
```

Spawn the `deploio-cli` agent for this only after the user confirms both conditions above.

---

## Phase 5: Apply the fix

After diagnosis, use `AskUserQuestion` to present the proposed fix before applying:

```
question: "The app is crashing because <root cause>. Apply the fix?"
options:
  - "Yes, apply the fix"
  - "Show me more details first"
  - "No, I'll handle it manually"
```

Then apply it directly by spawning a `deploio-cli` agent with `mode: bypassPermissions`:

```
task: fix
app: <app-name>
project: <project>
fix: <operation>
values: <values>
```

Always present before executing:
> "The app is crashing because `SECRET_KEY_BASE` is missing. I'll add it now — proceed?"

| Root cause | nctl command to run |
|---|---|
| Missing env var | `nctl update app <name> --project <project> --env=KEY=VALUE` |
| Migration failed transiently | `nctl update app <name> --project <project> --retry-release` |
| Build failed | `nctl update app <name> --project <project> --retry-build` |
| Port mismatch | `nctl update app <name> --project <project> --port=<correct-port>` |
| Slow migration | `nctl update app <name> --project <project> --deploy-job-timeout=15m` |
| OOM / restart loop | `nctl update app <name> --project <project> --size=standard-1` |
| Build env issue | `nctl update app <name> --project <project> --build-env=KEY=VALUE` then `--retry-build` |

After applying the fix, spawn a brief monitor agent (`nctl get app <name> --project <project> --watch`) to confirm the app reaches `Running` status and relay the result. Update the task with `TaskUpdate` — `status: completed` on success, `status: failed` on persistent failure.

---

## Retry commands

```bash
# Re-trigger a full build (new build from git)
nctl update app <name> --project <project> --retry-build

# Re-deploy existing build (skip rebuild, re-run release + deploy job)
nctl update app <name> --project <project> --retry-release
```

| Use `--retry-release` when | Use `--retry-build` when |
|---|---|
| Migration failed transiently | Build itself failed |
| Config-only change needed | Dependency or build-env changed |
| Transient infra issue | Build-time env var changed |

---

## Common problems and fixes

Read `skills/shared/troubleshooting.md` for the full problem/fix reference table, organized by failure stage (build, deploy job, boot, runtime, domain, git). Use the `likely_cause` field from the Phase 1 report to jump directly to the relevant section.
