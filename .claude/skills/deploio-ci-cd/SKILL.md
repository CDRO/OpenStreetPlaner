---
name: deploio-ci-cd
description: Sets up automated deployments to Deploio from CI/CD pipelines using nctl service accounts. This skill should be triggered when the user wants to automate deployments: "GitHub Actions Deploio", "CI/CD for Deploio", "auto-deploy to Deploio", "deploy on push", "automate deployments", "configure deployment pipeline", "automate releases", "GitLab CI deploy", "CircleCI deploy", "Deploio in pipeline". Covers service account creation, credential management, GitHub Actions workflow templates, and multi-environment (staging/production) patterns. Works with any CI system. Do NOT use for manual one-time deployments (use deploio-deploy or deploio-manage).
license: MIT
metadata:
  version: 1.3.0
---

# Deploio: CI/CD Setup

Your role is coordinator. You never run commands yourself — you spawn `deploio-cli` agents with `mode: bypassPermissions` for nctl execution, and use the Write tool (or spawn a file-writer agent) to create workflow files. Gather what's needed, confirm the plan, then set everything up in one pass.

**Communication style:** Speak to the user in plain language — describe what will be set up, never show raw nctl commands in your responses. Agents manage the CLI entirely on the user's behalf.

---

## Phase 0: Pre-flight — gather context

**Before asking questions, briefly preview what you'll build** so the user knows what to expect:

> I'll set up automated Deploio deployments. The workflow will:
> - Install nctl in CI
> - Authenticate using three repo secrets you'll add: `NCTL_API_CLIENT_ID`, `NCTL_API_CLIENT_SECRET`, `NCTL_ORGANIZATION`
> - Deploy your app on every push

**Autoinfer project and app from git context:**
```bash
git remote get-url origin   # https://github.com/acme/myapp → repo name only (not the org)
  nctl auth whoami             # → active organization (marked with *)
git branch --show-current   # main → app=main (single env) or hints at multi-env
```
Derive: `app = <branch>` (e.g. `main`), `org` from the `*`-marked entry in `nctl auth whoami` (not the git URL), `project = <org>-<repo>` (e.g. `renuotest-myapp` — never just `<repo>`; nctl errors).

State your inference: *"I'll configure CI/CD for app `main` in project `renuotest-myapp` (org `renuotest`) — let me know if that's different."* Only ask if there is no git remote or if a subsequent nctl command fails because the organization doesn't exist.

Then ask for whatever else is missing:

| Field | Ask if not known |
|---|---|
| **CI platform** | GitHub Actions (default), GitLab CI, CircleCI, Bitbucket Pipelines, other |
| **App name(s)** | the app(s) that should be auto-deployed (default: inferred from repo) |
| **Environments** | single (main → production) or multi (develop → staging, main → production) |
| **Service account name** | default: `<ci-platform>-deploy` (e.g. `github-actions-deploy`) |

---

## Phase 1: Confirm the plan

Call `EnterPlanMode` before presenting the plan summary:

```
Here's what I'll set up:

| Setting | Value |
|---|---|
| Service account | github-actions-deploy (scoped to acme-production) |
| Workflow file | .github/workflows/deploy.yml |
| Trigger | push to main → deploy myapp to acme-production |

After setup, you'll need to add three secrets to GitHub:
NCTL_API_CLIENT_ID, NCTL_API_CLIENT_SECRET, NCTL_ORGANIZATION

```

For multi-environment setups, show both branches and their targets before proceeding.

Call `ExitPlanMode` after the summary. Then use `AskUserQuestion` with these options to get the user's confirmation:

```
question: "Ready to set up CI/CD?"
options:
  - "Yes, exactly that"
  - "Yes, but… (tell me what to adjust — e.g. add staging environment)"
  - "No, cancel"
```

If the user selects "No, cancel" — do not spawn any agents.

---

## Phase 2: Create service account

Spawn the `deploio-cli` agent with `mode: bypassPermissions`:

```
task: create-service-account
name: <service-account-name>
scope: project  (use "organization" only if explicitly requested)
```

The agent runs:
```bash
# Create (project-scoped by default — least privilege)
nctl create apiserviceaccount <name>

# For org-wide access (all projects):
nctl create apiserviceaccount <name> --organization-access

# Retrieve credentials for v2 service accounts (current default)
# client_id and client_secret are shown separately:
nctl get apiserviceaccount <name> --print-client-id
nctl get apiserviceaccount <name> --print-client-secret
# Or view everything at once:
nctl get apiserviceaccount <name> -o yaml
```

Present the `client_id` and `client_secret` to the user immediately with instructions to store them safely. The secret cannot be retrieved again after this point — if lost, the account must be deleted and recreated.

> **Rotation:** If credentials are ever exposed, delete and recreate immediately:
> ```bash
> nctl delete apiserviceaccount <name>
> nctl create apiserviceaccount <name>
> # → update CI secrets with new client_id + client_secret
> ```

---

## Phase 3: Write the workflow file

Write the workflow file directly (or spawn a file-writer agent). Choose the template based on Phase 0 answers.

### How nctl auth works in CI

nctl's authentication in CI requires two steps, performed once per job:

1. **Set env vars** — nctl reads `NCTL_API_CLIENT_ID`, `NCTL_API_CLIENT_SECRET`, and `NCTL_ORGANIZATION` from the environment
2. **Call `nctl auth login`** — this exchanges the client credentials for a kubeconfig token; subsequent commands in the same job use that token automatically
3. **Call `nctl auth set-project <project> --force`** — sets the active project context; `--force` is required for service accounts because they cannot verify project existence interactively

The three env vars must be set before calling `nctl auth login`. Once login succeeds, all subsequent nctl commands in that shell session use the resulting kubeconfig automatically.

### How to install nctl in CI

nctl release assets are named with the version number (e.g. `nctl_1.14.2_linux_amd64.tar.gz`), so a static "latest" tar.gz URL does not exist. Use the official nine.ch apt repository instead — it tracks the latest release and works on all Ubuntu/Debian CI runners:

```bash
echo "deb [trusted=yes] https://repo.nine.ch/deb/ /" \
  | sudo tee /etc/apt/sources.list.d/repo.nine.ch.list
sudo apt-get update -qq
sudo apt-get install -y nctl
```

This is the recommended and most reliable install method for GitHub Actions (ubuntu-latest), GitLab CI, CircleCI, and any Debian/Ubuntu runner.

### GitHub Actions — single environment

**`.github/workflows/deploy.yml`:**
```yaml
name: Deploy to Deploio

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Install nctl
        run: |
          echo "deb [trusted=yes] https://repo.nine.ch/deb/ /" \
            | sudo tee /etc/apt/sources.list.d/repo.nine.ch.list
          sudo apt-get update -qq
          sudo apt-get install -y nctl

      - name: Authenticate and deploy
        env:
          NCTL_API_CLIENT_ID: ${{ secrets.NCTL_API_CLIENT_ID }}
          NCTL_API_CLIENT_SECRET: ${{ secrets.NCTL_API_CLIENT_SECRET }}
          NCTL_ORGANIZATION: ${{ secrets.NCTL_ORGANIZATION }}
        run: |
          nctl auth login
          nctl auth set-project "$NCTL_ORGANIZATION" --force
          # Use the commit SHA so the build is deterministic and always triggers
          # a new build even when the branch tip has not changed
          nctl update app <app-name> \
            --git-revision="${{ github.sha }}"

      - name: Wait for deployment
        env:
          NCTL_API_CLIENT_ID: ${{ secrets.NCTL_API_CLIENT_ID }}
          NCTL_API_CLIENT_SECRET: ${{ secrets.NCTL_API_CLIENT_SECRET }}
          NCTL_ORGANIZATION: ${{ secrets.NCTL_ORGANIZATION }}
        run: |
          for i in $(seq 1 30); do
            PHASE=$(nctl get app <app-name> -o yaml \
              | awk '/^status:/{in_status=1} in_status && /  phase:/{print $2; exit}')
            echo "  phase: $PHASE (check $i/30)"
            case "$PHASE" in
              Running) echo "Deployment complete."; exit 0 ;;
              Failed)  echo "Deployment failed — check logs with deploio-debug."; exit 1 ;;
            esac
            sleep 10
          done
          echo "Timed out waiting for deployment (300s)."
          exit 1
```

### GitHub Actions — multi-environment (staging + production)

**`.github/workflows/deploy.yml`:**
```yaml
name: Deploy

on:
  push:
    branches: [main, develop]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Set environment
        id: env
        run: |
          echo "project=acme-myapp" >> $GITHUB_OUTPUT
          if [ "${{ github.ref }}" = "refs/heads/main" ]; then
            echo "app=main" >> $GITHUB_OUTPUT
          else
            echo "app=develop" >> $GITHUB_OUTPUT
          fi

      - name: Install nctl
        run: |
          echo "deb [trusted=yes] https://repo.nine.ch/deb/ /" \
            | sudo tee /etc/apt/sources.list.d/repo.nine.ch.list
          sudo apt-get update -qq
          sudo apt-get install -y nctl

      - name: Authenticate and deploy
        env:
          NCTL_API_CLIENT_ID: ${{ secrets.NCTL_API_CLIENT_ID }}
          NCTL_API_CLIENT_SECRET: ${{ secrets.NCTL_API_CLIENT_SECRET }}
          NCTL_ORGANIZATION: ${{ secrets.NCTL_ORGANIZATION }}
        run: |
          nctl auth login
          nctl auth set-project "${{ steps.env.outputs.project }}" --force
          nctl update app "${{ steps.env.outputs.app }}" \
            --git-revision="${{ github.sha }}"
```

> `--force` is required with `set-project` for service accounts: they cannot interactively verify project existence, so the flag tells nctl to set the project context regardless.

### Other CI systems (GitLab CI, CircleCI, Bitbucket Pipelines, etc.)

The nctl auth pattern is identical across CI systems — install via apt, set env vars, then login:

```bash
# Install (Debian/Ubuntu runners)
echo "deb [trusted=yes] https://repo.nine.ch/deb/ /" \
  | sudo tee /etc/apt/sources.list.d/repo.nine.ch.list
sudo apt-get update -qq && sudo apt-get install -y nctl

# Authenticate — env vars must be set before calling auth login
export NCTL_API_CLIENT_ID="$NCTL_API_CLIENT_ID"
export NCTL_API_CLIENT_SECRET="$NCTL_API_CLIENT_SECRET"
export NCTL_ORGANIZATION="$NCTL_ORGANIZATION"
nctl auth login
nctl auth set-project "$NCTL_ORGANIZATION" --force
nctl update app <name> --git-revision="$CI_COMMIT_SHA"
```

**GitLab CI** — store `NCTL_API_CLIENT_ID`, `NCTL_API_CLIENT_SECRET`, `NCTL_ORGANIZATION` in Settings → CI/CD → Variables (masked).
**CircleCI** — store in Project Settings → Environment Variables.
**Bitbucket Pipelines** — store in Repository Settings → Repository variables.

---

## Phase 4: Guide through storing secrets

After writing the workflow file, instruct the user where to add the secrets for their CI platform:

**GitHub:**
> Go to your repository → Settings → Secrets and variables → Actions → New repository secret

| Secret | Value |
|---|---|
| `NCTL_API_CLIENT_ID` | `client_id` from Phase 2 |
| `NCTL_API_CLIENT_SECRET` | `client_secret` from Phase 2 |
| `NCTL_ORGANIZATION` | Your Deploio project name (e.g. `acme-production`) |

`NCTL_ORGANIZATION` is the Deploio **project** name (not the organization name). It is passed to `nctl auth set-project` to select the correct project context in CI.

For multi-environment setups with separate secrets per environment, use GitHub Environments instead of repository secrets.

---

## Preview environments (per-PR apps)

Preview environments create a temporary Deploio app for each pull request. Key design constraints:

1. **Backing services are NOT copied** — the preview app gets its own app container, but databases, Redis KVS, and other services from the base app are not duplicated. You must either:
   - Provision separate lightweight backing services for preview envs (e.g. Economy PostgreSQL per PR), or
   - Point preview apps at a shared staging database (with appropriate isolation)
   - Tell the user explicitly: *"Preview apps don't automatically get their own database — I'll provision a separate Economy PostgreSQL for each preview, or you can share the staging database."*

2. **Lifecycle**: Create the app on PR open, delete it on PR close.

3. **App naming**: use `pr-<number>` (e.g. `pr-42`) — scoped within the `<org>-<repo>` project

**GitHub Actions template for preview environments:**

```yaml
name: Preview Environment

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - name: Install nctl
        run: |
          echo "deb [trusted=yes] https://repo.nine.ch/deb/ /" \
            | sudo tee /etc/apt/sources.list.d/repo.nine.ch.list
          sudo apt-get update -qq && sudo apt-get install -y nctl

      - name: Authenticate
        env:
          NCTL_API_CLIENT_ID: ${{ secrets.NCTL_API_CLIENT_ID }}
          NCTL_API_CLIENT_SECRET: ${{ secrets.NCTL_API_CLIENT_SECRET }}
          NCTL_ORGANIZATION: ${{ secrets.NCTL_ORGANIZATION }}
        run: |
          nctl auth login
          nctl auth set-project "$NCTL_ORGANIZATION" --force

      - name: Create or update preview app
        if: github.event.action != 'closed'
        env:
          NCTL_API_CLIENT_ID: ${{ secrets.NCTL_API_CLIENT_ID }}
          NCTL_API_CLIENT_SECRET: ${{ secrets.NCTL_API_CLIENT_SECRET }}
          NCTL_ORGANIZATION: ${{ secrets.NCTL_ORGANIZATION }}
        run: |
          APP="pr-${{ github.event.pull_request.number }}"
          # Create if not exists, otherwise update
          if ! nctl get app "$APP" 2>/dev/null; then
            nctl create app "$APP" \
              --git-url="${{ github.event.pull_request.head.repo.clone_url }}" \
              --git-revision="${{ github.sha }}" \
              --port=3000 \
              --size=mini
          else
            nctl update app "$APP" --git-revision="${{ github.sha }}"
          fi

      - name: Delete preview app on PR close
        if: github.event.action == 'closed'
        env:
          NCTL_API_CLIENT_ID: ${{ secrets.NCTL_API_CLIENT_ID }}
          NCTL_API_CLIENT_SECRET: ${{ secrets.NCTL_API_CLIENT_SECRET }}
          NCTL_ORGANIZATION: ${{ secrets.NCTL_ORGANIZATION }}
        run: |
          nctl delete app "pr-${{ github.event.pull_request.number }}" || true
```

---

## Phase 5: Next steps after setup

```
CI/CD is ready. Push to main to trigger your first automated deploy.

What's next?
  → Add staging environment   — I can add a second workflow branch
  → Preview environments      — per-PR apps (note: backing services need separate provisioning)
  → Rotate credentials        — delete and recreate the service account
  → Monitor deployments       — use deploio-debug to watch logs
  → Add a database            — use deploio-provision
```

---

## Managing service accounts

```bash
# List
nctl get apiserviceaccount

# Inspect (client_id visible; secret cannot be retrieved after creation)
nctl get apiserviceaccount <name> -o yaml
nctl get apiserviceaccount <name> --print-client-id

# Rotate credentials: delete and recreate (only way to get a new secret)
nctl delete apiserviceaccount <name>
nctl create apiserviceaccount <name>
# → update CI secrets with new client_id + client_secret
```

---

## Security notes

- Create **one service account per pipeline/environment** — don't share credentials across pipelines
- Use **project-scoped** accounts (not `--organization-access`) unless org-wide access is explicitly needed
- **Rotate immediately** if credentials are ever exposed: delete + recreate + update CI secrets
- Never commit `NCTL_API_CLIENT_SECRET` to the repository, `.env` files, or workflow YAML `env:` blocks — use CI secrets exclusively
- Service account v1 accounts expired December 1, 2025 — always create v2 accounts (requires nctl v1.12.1+)

---

## Common CI/CD issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `authentication failed` in CI | Secrets not set or wrong values | Check secret names match exactly: `NCTL_API_CLIENT_ID`, `NCTL_API_CLIENT_SECRET`, `NCTL_ORGANIZATION` |
| `nctl: command not found` | Install step failed | Ensure apt repo step ran; check runner OS is Debian/Ubuntu |
| `set-project failed` | Project name wrong or account lacks access | Verify project name with `nctl get projects` locally; confirm `--force` flag is present |
| Deploy step succeeds but app not updated | `--git-revision` not pointing to correct SHA | Ensure `${{ github.sha }}` (GitHub) or `$CI_COMMIT_SHA` (GitLab) resolves in context |
| Wait step times out | Deploy job running slow | Increase sleep iterations or check deploy job logs with deploio-debug |
| Multi-env: wrong environment deployed | Branch condition wrong | Check `github.ref` format: `refs/heads/main` not `main` |
| Service account deleted by accident | — | Recreate with same name, update CI secrets with new credentials |
| `invalid_client` error | Stale or wrong client credentials | Rotate: delete and recreate the service account, update CI secrets |
