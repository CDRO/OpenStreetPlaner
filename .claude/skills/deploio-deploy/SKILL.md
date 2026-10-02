---
name: deploio-deploy
description: Handles first-time deployment of an app to Deploio — from git URL to live HTTPS URL. This skill should be triggered when deploying a new app for the first time: "deploy my app on Deploio", "create a Deploio app", "how do I deploy to Deploio", "host on Deploio", "push to Deploio", "new app on Deploio", "first deploy to Deploio", "set up a new Deploio app", or setting up a new Deploio app from scratch. Covers auth, project setup, git credential resolution, buildpack/Dockerfile detection, and build monitoring. Do NOT use for apps already running on Deploio (use deploio-manage to update them).
license: MIT
metadata:
  version: 1.3.0
---

# Deploio: First-Time App Deployment

Your role is coordinator. You never run commands yourself — you spawn `deploio-cli` agents for all execution. Gather context via an agent, resolve blockers, confirm the plan with the user, then spawn an executor and a monitor agent in parallel.

**Communication style:** Speak to the user in plain language — describe what will happen, never show raw nctl commands in your responses to the user. Agents manage the CLI entirely on the user's behalf. Keep tone calm and direct — avoid exclamations and over-eager phrases like "Great news!" or "Awesome!".

---

## Phase 0: Pre-flight check (from conversation context only — no commands)

Before spawning any agent, evaluate these four conditions from what the user has already told you:

| Condition | Known if… |
|---|---|
| `nctl_known` | User mentioned installing nctl, or ran it in this session |
| `remote_known` | A git URL is visible in the conversation |
| `auth_known` | User mentioned a Deploio project name or logged in |
| `framework_known` | User said "Rails app", "Next.js", etc. |

If `remote_known` is false, run `git remote get-url origin` and `git branch --show-current` to discover the URL and branch. If a remote is found, derive `app = <branch>` (e.g. `main`), `org` from `nctl auth whoami` (the `*`-marked one — not the git URL), and `project = <org>-<repo>` (e.g. `renuotest-myapp` — never just `<repo>`; nctl errors). State: *"I'll deploy project `renuotest-myapp`, app `main`, in organization `renuotest` — let me know if that's different."* Only ask for a URL from scratch if no remote is configured.

Pass any known values into the gather-context spec as hints to speed up detection.

---

## Phase 1: Gather context

Spawn the `deploio-cli` agent with `mode: bypassPermissions` and this spec:

```
task: gather-context
hints:
  remote_url: <from context, or null>
  framework: <from context, or null>
  nctl_installed: <from context, or null>
```

### What the agent must do

**Constraints:** Do not run any `nctl` commands during context gathering — nctl commands may require auth and will produce misleading errors before the project exists. Use only: git commands, file system reads, and `nctl version`.

**Detection steps:**

1. `nctl version` → set `nctl_installed: true/false`; require at least v1.16.0 for Deploio support
2. Use the `remote_url` hint if provided; otherwise run `git remote get-url origin` → set `remote_url`
3. `git branch --show-current` → set `branch`
4. Read project files to detect `app_type` and `port` (framework details live in `references/<FRAMEWORK>.md`):

| File present | app_type | default port |
|---|---|---|
| `Dockerfile` | docker | read from `EXPOSE` line, else 8080 |
| `Gemfile` containing `rails` | rails | 3000 |
| `package.json` | nodejs | 3000 |
| `manage.py` + `requirements.txt` | django | 8000 |
| `app.py` or `main.py` + `requirements.txt` | flask | 8000 |
| `composer.json` | php | 8080 |
| `go.mod` | go | 8080 |
| none matched | unknown | null |

5. Detect `git_auth_type`:
   - If `remote_url` starts with `git@` → `ssh`
   - If `remote_url` starts with `https://` → `https`
   - If `remote_url` is null → `none`

6. Check for multiple subdirectories each containing a `Gemfile`, `package.json`, or `go.mod` → set `is_monorepo: true/false`

7. Run `nctl auth whoami` (only if nctl is installed). Parse the output to find:
   - `active_org`: the organization marked with `*` in the list (e.g. `* renuotest`)
   - `available_orgs`: the full list of organization names

   The `active_org` is the one already selected — use it without asking. Only surface org selection if `active_org` is null (nothing marked active).

8. Check for a `.deploio.yaml` file in the repo root → set `has_deploio_yaml: true/false`. If present, note which keys it defines (deployJob, size, env, healthProbe, etc.) so the coordinator can skip asking about those.

### Return schema (JSON)

```json
{
  "nctl_installed": true,
  "remote_url": "https://github.com/org/repo.git",
  "branch": "main",
  "app_type": "rails",
  "port": 3000,
  "git_auth_type": "https",
  "is_monorepo": false,
  "active_org": "acme-production",
  "available_orgs": ["acme-production", "acme-staging"],
  "has_deploio_yaml": false,
  "blockers": []
}
```

`blockers` is a list of strings, e.g. `["nctl not installed", "no git remote"]`.

---

## Phase 2: Resolve blockers

Handle each blocker before proceeding:

**nctl not installed:**
```bash
brew install ninech/tap/nctl          # macOS
# Linux: download from https://github.com/ninech/nctl/releases/latest
```
Re-run Phase 1 after install.

**nctl version too old:** Deploio requires nctl v1.16.0 or newer. Run `brew upgrade ninech/tap/nctl` (macOS) or re-download from releases.

**No git remote:** Deploio always pulls from a git host — it never receives files directly.
```bash
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```
Continue once the user confirms it's pushed.

**nctl not authenticated:** Ask the user to run `nctl auth login` (opens browser OAuth) then `nctl auth set-project <project>`.

**app_type unknown:** Ask the user what runtime their app uses before proceeding.

---

## Phase 2b: Git credentials (private repos)

**GitHub note:** GitHub does not support HTTPS deploy tokens for nctl. Use SSH deploy keys for GitHub private repos.

If `git_auth_type` is `ssh`:
- Ask the user for the path to their deploy key, or offer to use `~/.ssh/id_ed25519`
- They can generate a dedicated key: `ssh-keygen -t ed25519 -f ~/deploio.key -N ''`
- Pass `git_ssh_key_path` to the executor spec

If `git_auth_type` is `https` (GitLab or Bitbucket only):
- GitLab: Settings → Access Tokens → `read_repository`; pass the token name as `git_username` and the token value as `git_password`
- Bitbucket: Repository settings → Access tokens → `Repository read`; use `x-auth-token` as the username field
- Pass `git_username` and `git_password` to the executor spec

If the repo is public, skip this phase.

---

## Phase 2c: Organization selection

`nctl auth whoami` returns the currently active organization (marked `*`) and the full list.

**Normal case — active org exists:** Use `active_org` directly. Do not ask. The plan card will show it for confirmation.

**Edge case — no active org:** Present the list and ask:

```
Your account has access to multiple Deploio organizations:
  1. acme-production
  2. acme-staging

Which organization should this app be deployed to?
(Or run `nctl auth set-org <name>` first to set a default.)
```

Set `selected_org` from the user's answer.

> **Terminology note:** Deploio calls the top-level grouping an **organization** (set with `nctl auth set-org`). The app lives within the organization. Do not use the word "project" when referring to this selection — it confuses users who see organization names in `nctl auth whoami` output.

---

## Phase 3: Propose the plan

The plan card **MUST always include Organization, Project, and App** — all three, in this order. Never omit Project.

**Read the framework file before building the plan card.** Once `app_type` is known from Phase 1, read the corresponding file:

| app_type | File to read |
|---|---|
| `rails` | `skills/deploio-deploy/references/RAILS.md` |
| `nodejs` | `skills/deploio-deploy/references/NODE.md` |
| `django` / `flask` | `skills/deploio-deploy/references/PYTHON.md` |
| `php` | `skills/deploio-deploy/references/PHP.md` |
| `go` | `skills/deploio-deploy/references/GO.md` |
| `docker` | `skills/deploio-deploy/references/DOCKER.md` |
| `unknown` | Ask the user before proceeding |

Each file contains: default instance size, required env vars, deploy job command, health probe path, and framework-specific warnings. Use these to populate both the plan card and the executor spec.

```
Here's what I'll set up:

| Setting | Value |
|---|---|
| Organization | <selected_org> |
| Project | <selected_org>-<repo-name> |
| App | <branch> |
| Source | github.com/org/repo · <branch> branch |
| Build | Docker (or: auto-detected buildpack) |
| Size | <from framework file — e.g. mini for Rails, micro for Node.js/Go/Python> |
| Replicas | 1 |

<Framework defaults block — copy "Plan card defaults" section from the framework file>

Deploio will build your app from source in the cloud and give it an HTTPS URL
on deploio.app. By default the URL is publicly accessible — if you'd like to
restrict access with a username and password prompt, just say so and I'll
enable basic auth.
First build and release takes ~2–5 minutes.

```

Use `EnterPlanMode` before presenting the plan card so the user can review it fully before committing. Use `AskUserQuestion` to get confirmation:

```
question: "Ready to deploy?"
options:
  - "Yes, exactly that"
  - "Yes, but… (tell me what to adjust)"
  - "No, cancel"
```

Call `ExitPlanMode` once the user confirms or cancels.

Derive names:
- **Organization**: `active_org` from `nctl auth whoami` (the `*`-marked entry)
- **Project**: `<org>-<repo>` (e.g. `renuotest-myapp` — never just `<repo>`; nctl errors)
- **App**: `<branch>` (e.g. `main`)

**Available instance sizes** (set at creation or anytime after with `nctl update app`):

| Size | RAM | CPU | CHF/month |
|---|---|---|---|
| micro | 256 MiB | 0.125 | ~8 |
| mini | 512 MiB | 0.25 | ~16 |
| standard-1 | 1 GiB | 0.50 | ~32 |
| standard-2 | 2 GiB | 0.75 | ~58 |

If the user requests basic auth, set `basic_auth: true` in the executor spec.

If the user says "cancel" or "stop" — do not spawn any agents. Offer to restart later.
If the user adjusts a name — update the spec and re-present the card before proceeding.

---

## Phase 4: Execute — spawn two background agents

Once confirmed, use `TaskCreate` to create a task named "Deploying `<app-name>`" (status: `in_progress`) so the user has a visible progress tracker. Then spawn **two `deploio-cli` agents** with `mode: bypassPermissions` and return to the conversation.

**Agent 1 — executor**

```
task: deploy
org: <selected_org>
app: <app-name>
git_remote: <remote_url>
branch: <branch>
build: docker | buildpack
port: <port>
size: <size>  # default: mini for Rails, micro for everything else
replicas: <replicas or null>
basic_auth: <true or false>
env_vars: <see framework table in references/frameworks.md>
build_env_vars: <see notes below>
deploy_job: <command or null>
deploy_job_timeout: <duration or null>
health_probe_path: <path or null>
git_ssh_key_path: <path or null>
git_username: <token name or null>
git_password: <token value or null>
git_sub_path: <subdir or null>
dockerfile_path: <path or null>
dockerfile_build_context: <path or null>
```

### Rails SECRET_KEY_BASE

For Rails apps, if `SECRET_KEY_BASE` is not already set by the user, the executor must generate one by running `openssl rand -hex 64` and using the output as the value. Do not ask the user to provide it.

### nctl commands the executor will run (in order)

```bash
# 1. Authenticate (skip if already logged in)
nctl auth login
nctl auth set-project <project>

# 2. Create the app
nctl create app <app> \
  --git-url=<git_remote> \
  --git-revision=<branch> \
  [--git-sub-path=<git_sub_path>]                        # monorepos only
  [--git-ssh-private-key-from-file=<git_ssh_key_path>]   # SSH auth
  [--git-username=<git_username>]                        # HTTPS auth (GitLab/Bitbucket)
  [--git-password=<git_password>]                        # HTTPS auth (GitLab/Bitbucket)
  --port=<port> \
  [--size=<size>]                                        # micro|mini|standard-1|standard-2
  [--replicas=<n>]                                       # default 1
  [--dockerfile]                                         # docker builds only
  [--dockerfile-path=<dockerfile_path>]                  # if Dockerfile is not in repo root
  [--dockerfile-build-context=<dockerfile_build_context>] # if build context differs
  [--build-env=<KEY=VALUE>] ...                          # build-time args; repeat or semicolon-separate
  --env=<KEY=VALUE> ...                                  # runtime env vars; repeat or semicolon-separate
  [--basic-auth]                                         # enable HTTP basic auth
  [--deploy-job-command="<deploy_job>"]                  # if deploy_job is set
  [--deploy-job-timeout=<deploy_job_timeout>]            # default 5m, range 1–30m
  [--deploy-job-retries=<n>]                             # default 3, max 5
  [--health-probe-path=<health_probe_path>]              # HTTP path for readiness check
  [--health-probe-period-seconds=<n>]                    # default 10, min 1
  [--hosts=<domain1,domain2>]                            # custom domains at creation time

# 3. Get the live URL and (if basic_auth) credentials
nctl get app <app> --project=<project>
[nctl get app <app> --basic-auth-credentials]            # if basic_auth is true
```

**Env var syntax:** Multiple env vars can be passed either as repeated flags (`--env=KEY1=VAL1 --env=KEY2=VAL2`) or semicolon-separated in a single flag (`--env='KEY1=VAL1;KEY2=VAL2'`). Both forms are accepted. The same syntax applies to `--build-env`.

On success, report back: `{ "status": "success", "url": "https://<username>:<password>@<host>", "basic_auth_credentials": { "username": "...", "password": "..." } | null }`
On failure, report back: `{ "status": "failed", "error": "<nctl error output>", "step": "create|auth|url" }`

**Agent 2 — monitor**

```
task: monitor-logs
app: <app-name>
org: <selected_org>
termination: stop when executor reports success or failure, or after 20 minutes — whichever comes first
```

The monitor streams `nctl logs app <app> --type build -f` and relays key lines to the coordinator at regular intervals (every ~30s or on meaningful events). On timeout, emit: `"Build is taking longer than expected — check Deploio dashboard for status."` and exit.

After spawning both:
> "Both agents are running — executor deploying, monitor watching logs. I'll update you as the build and release progresses, or ask me anything while it runs."

---

## Phase 5: Stay responsive while agents run

You are the coordinator — remain in the conversation. Do not block.

**When the monitor sends a progress update:** relay it naturally.
> "[45s] Build step: installing dependencies..."

**When the user asks for a status update:** share the latest from the monitor, or check agent status.

Use `SendMessage` to check in on background agents when the user asks for a status update, rather than waiting passively.

**When the executor reports `status: success`:**

Share the URL and any basic auth credentials, then offer structured next steps based on what the user mentioned earlier in the conversation:

```
Update the deployment task to `completed` using `TaskUpdate`. Then share the result:

Your app is live at [https://<host>](https://<username>:<password>@<host>)
(To rotate the password later: `nctl update app <app> --change-basic-auth-password`)

What's next?
  → Add a database      — I can provision PostgreSQL or Redis (deploio-provision)
  → Set a custom domain — point your DNS to Deploio, then add the domain to the app
  → Scale the app       — increase replicas or upgrade the instance size
  → Wire up CI/CD       — auto-deploy on every git push (deploio-ci-cd)
  → Nothing for now     — you're all set!
```

**Custom domain setup (if the user asks):**
1. Add the domain to the app: `nctl update app <app> --hosts=yourdomain.com`
2. Get the DNS records: `nctl get app <app> --dns` — this returns a DNS target and TXT verification record
3. For subdomains: create a `CNAME` pointing to the DNS target
4. For apex domains: use `ALIAS` (preferred) or `A` record; add the TXT verification record

Lead with the option most relevant to the conversation (e.g., if the user mentioned Postgres earlier, put that first).

**When the executor reports `status: failed`:**

Update the deployment task to `failed` using `TaskUpdate`. Translate the error into plain terms using the table below, then offer a concrete fix:
> "The build failed because Rails couldn't find SECRET_KEY_BASE. I'll generate a secure value for you and add it — want me to proceed?"

---

## Framework defaults (include in executor task spec)

The framework file (read in Phase 3) contains env vars, deploy job command, health probe path, and build notes. Use it to populate the executor spec — do not re-read it in Phase 4 if already read. If `app_type` is `unknown`, ask the user before spawning the executor.

---

## Backing services (mention if the user needs them)

If the user mentions PostgreSQL, MySQL, Redis, Sidekiq, or file storage:
> "Deploio can provision a managed PostgreSQL database, Redis-compatible KVS (for Sidekiq), and S3-compatible object storage. I can set those up once the app is live using deploio-provision."

Don't block the deployment for services — unless a required env var is missing (e.g. `REDIS_URL` for Sidekiq), in which case ask before proceeding.

---

## Worker jobs and scheduled jobs (mention if detected)

If the framework is Rails and `Gemfile` contains `sidekiq`, or the user mentions background workers, note that a worker job can be added at creation time with a dedicated size (defaults to `micro`).

**Scheduled jobs** (Deploio's term — do not call them "cron jobs") can be added with a name, schedule string, and command. Both worker jobs and scheduled jobs are configured on the same app resource and run in separate containers with their own resource allocation.

---

## .deploio.yaml — app config file (advanced, optional)

Only mention `.deploio.yaml` if the user seems like a team lead, is setting up a shared project, or explicitly asks about config management. Do not offer it to users doing a quick first deploy.

If it comes up naturally, explain it briefly:
> "If you're working in a team, a `.deploio.yaml` in your repo can track your deploy config in git — things like size, replicas, and deploy job settings — so the team can see and review changes. Want me to create one?"

Only create it if the user says yes. See `references/RAILS.md` (or the relevant framework file) for a template.

If a `.deploio.yaml` already exists (detected in Phase 1), read it to pre-fill the plan card values and skip any settings already defined there.

---

## Platform defaults and limitations

- All apps receive these env vars automatically: `PORT`, `DEPLOIO_APP_NAME`, `DEPLOIO_PROJECT_NAME`, `DEPLOIO_RELEASE_NAME`
- Ephemeral storage is 2 GiB per app; writes outside designated writable paths may fail or cause OOM (exit 137)
- Buildpack apps: writable paths are restricted (e.g. `/workspace/tmp`); Dockerfile apps control their own filesystem permissions
- Only the `web` key in a Procfile is respected; other process types are ignored
- Logs are retained for 30 days
- Resources (RAM, CPU) are allocated per replica — scaling replicas multiplies cost proportionally
- If resource usage exceeds the instance limit, Nine may terminate the app

---

## Common first-deploy issues

Read `skills/shared/troubleshooting.md` for a full list of problems and fixes. Key patterns to diagnose from executor error output:

- Log contains `KeyError` or `NameError` → missing env var → add it and retry
- Log contains `PG::ConnectionBad` → `DATABASE_URL` not set → re-run with env var
- App returns 502 → port mismatch → check framework port in `references/frameworks.md`
- Build fails, lock file error → `Gemfile.lock` or `package-lock.json` not committed
- OOM / exit code 137 → app exceeds memory for selected instance size → upgrade to next size tier
- TLS cert not issued → DNS not yet pointing to Deploio; remove AAAA records during migration

If the first deploy fails (build or release), offer to retry via deploio-manage: `--retry-build` (build failure) or `--retry-release` (release/migration failure).
