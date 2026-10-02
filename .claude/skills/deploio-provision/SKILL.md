---
name: deploio-provision
description: Provisions and connects managed backing services to Deploio apps — PostgreSQL, MySQL, Redis-compatible KVS, OpenSearch, and S3-compatible object storage. This skill should be triggered when the user needs to add a database, cache, or storage service: "add postgres to Deploio", "provision MySQL", "need a database on Deploio", "add Redis", "create KVS", "set up object storage", "add OpenSearch", "connect database to Deploio app", "add Sidekiq", "background jobs on Deploio", "file uploads on Deploio", "object storage Deploio". Handles creation, credential extraction, env var injection, and connection verification. Do NOT use for app config changes unrelated to backing services (use deploio-manage).
license: MIT
metadata:
  version: 1.3.0
---

# Deploio: Provisioning Backing Services

Your role is coordinator. You never run commands yourself — you spawn `deploio-cli` agents with `mode: bypassPermissions`. Confirm the plan before provisioning (service creation is not instant to undo), then execute create + inject + verify in sequence.

**Communication style:** Speak to the user in plain language — describe what you'll provision and what env vars will be set, never show raw nctl commands. Agents manage the CLI entirely on the user's behalf.

---

## Phase 0: Identify what's needed

**Autoinfer app and project before asking.** Run:
```bash
git remote get-url origin   # https://github.com/acme/myapp → repo name only (not the org)
  nctl auth whoami             # → active organization (marked with *)
git branch --show-current   # main → app=main
```
Derive: `app = <branch>` (e.g. `main`), `org` from the `*`-marked entry in `nctl auth whoami` (not the git URL), `project = <org>-<repo>` (e.g. `renuotest-myapp` — never just `<repo>`; nctl errors).

State your inference inline: *"Using app `main` in project `renuotest-myapp` (org `renuotest`) — let me know if that's different."* Proceed with the inferred values. Only ask explicitly if there is no git remote, or if a subsequent nctl command fails because the organization doesn't exist.

From the conversation, also determine:
- **Service type** — from the table below
- **Service name** — default to `<app-name>-<service-type>` (e.g. `myapp-db`)
- **Tier** — Economy (shared, lower cost, dev/staging) vs Business (dedicated, production)

**Include the plan skeleton in the same message as your inference**, so the user understands what will happen. For example, when adding PostgreSQL:

> I see your app is `main` in project `renuotest-myapp` (org `renuotest`) — let me know if that's different.
> Here's what I'll set up:
> - A managed PostgreSQL Economy database (shared, good for non-production)
> - `DATABASE_URL` manually injected into your app's environment

**Service type lookup:**

| User need | Tier options | nctl resource name |
|---|---|---|
| Relational DB (PostgreSQL, default) | Economy (`postgresdatabase`) · Business (`postgresql`) | see tier note below |
| Relational DB (MySQL / PHP / legacy) | Economy (`mysqldatabase`) · Business (`mysql`) | see tier note below |
| Cache / queues / sessions (Redis-compatible) | Single tier (`keyvaluestore`) | `keyvaluestore` |
| Full-text search | Beta (`opensearch`) | `opensearch` |
| File / object storage (S3-compatible) | Single tier | `bucket` + `bucketuser` |

**Tier note:** For PostgreSQL and MySQL, the Economy and Business tiers use *different* nctl resource names:
- Economy: `postgresdatabase` / `mysqldatabase` — shared infrastructure, up to 10 GB, max 20 connections, no dedicated resources.
- Business: `postgresql` / `mysql` — dedicated VM, choose machine type (`nine-db-xs` through `nine-db-xxl`), production-grade.

When the user hasn't specified a tier, ask: *"Is this for production, or dev/staging? That determines whether I use the Economy (shared) or Business (dedicated) tier."*

---

## Phase 1: Confirm the plan

Before creating anything, call `EnterPlanMode` to present the plan card:

```
Here's what I'll set up:

| Setting | Value |
|---|---|
| Service | PostgreSQL Economy |
| Name | myapp-db |
| App | myapp |
| Env var | DATABASE_URL (manually injected — not auto-injected by Deploio) |

Deploio does NOT auto-inject connection strings. After creation I'll extract
the credentials and inject DATABASE_URL for you.

Provisioning takes ~1–2 minutes.
```

Call `ExitPlanMode` after presenting the plan. Then use `AskUserQuestion` with these options to get the user's confirmation:

```
question: "Ready to provision?"
options:
  - "Yes, exactly that"
  - "Yes, but… (tell me what to adjust)"
  - "No, cancel"
```

If the user says "No, cancel" — do not spawn any agents.

---

## Phase 2: Execute — create, extract credentials, inject env vars

Create a task with `TaskCreate` when provisioning starts:

```
title: "Provisioning <service-type> for <app-name>"
status: in_progress
```

Spawn the `deploio-cli` agent with `mode: bypassPermissions`:

```
task: provision
service_type: postgresdatabase | postgresql | mysqldatabase | mysql | keyvaluestore | opensearch | bucket
service_name: <name>
app: <app-name>
```

### nctl commands by service type

---

#### PostgreSQL Economy (`postgresdatabase`)

```bash
# 1. Create (no --allowed-cidrs on Economy tier)
nctl create postgresdatabase <service-name>

# 2. Get connection details
FQDN=$(nctl get postgresdatabase <service-name>)
USER=$(nctl get postgresdatabase <service-name> --print-user)
PASS=$(nctl get postgresdatabase <service-name> --print-password)
# Note: database name == username on Economy tier

# 3. Inject into app
nctl update app <app-name> \
  --env=DATABASE_URL=postgresql://${USER}:${PASS}@${FQDN}:5432/${USER}?sslmode=require

# 4. (Optional) Get CA cert for strict TLS verification
nctl get postgresdatabase <service-name> --print-ca-cert > db-ca.pem
```

**Economy sizing:** Automatically scales S (1 GB, 20 conn) → M (5 GB) → L (10 GB) based on usage. Price is automatic — no size flag needed.

**Proactive coordinator message:** *"Economy PostgreSQL is shared infrastructure — great for dev/staging. For production I'd recommend Business tier with dedicated resources. Want me to use Business instead?"*

---

#### PostgreSQL Business (`postgresql`)

```bash
# 1. Create — recommended flags for production
#    Use 0.0.0.0/0 by convention — TLS + credentials provide security; restrict later if needed
nctl create postgresql <service-name> \
  --machine-type=nine-db-s \
  --pg-version=17 \
  --allowed-cidrs=0.0.0.0/0

# 2. Get connection details
FQDN=$(nctl get postgresql <service-name>)
USER=$(nctl get postgresql <service-name> --print-user)   # default: dbadmin
PASS=$(nctl get postgresql <service-name> --print-password)

# 3. Inject into app
nctl update app <app-name> \
  --env=DATABASE_URL=postgresql://${USER}:${PASS}@${FQDN}:5432/postgres?sslmode=require

# 4. (Optional) Get CA cert
nctl get postgresql <service-name> --print-ca-cert > db-ca.pem

# 5. Add/update IP allowlist after creation
nctl update postgresql <service-name> --allowed-cidrs=203.0.113.1/32
```

**Machine types (`--machine-type`):**
| Type | vCPU | RAM | Storage | Recommended for |
|---|---|---|---|---|
| `nine-db-xs` | 2 | 4 GB | 20 GB | Light production |
| `nine-db-s` | 4 | 8 GB | 20 GB | Standard production *(default rec.)* |
| `nine-db-m` | 4 | 12 GB | 20 GB | Medium workloads |
| `nine-db-l` | 6 | 16 GB | 20 GB | Heavy workloads |
| `nine-db-xl` | 8 | 24 GB | 20 GB | Large workloads |
| `nine-db-xxl` | 10 | 32 GB | 20 GB | Very large workloads |

**PostgreSQL versions (`--pg-version`):** 17, 16, 15 — **cannot be changed after creation**.

**IP allowlist note:** `--allowed-cidrs` is a comma-separated list of IPv4 CIDR ranges. By convention, use `0.0.0.0/0` — TLS encryption and strong credentials provide the actual security layer. Restricting by IP adds friction without meaningful benefit on a TLS-protected service. Deploio apps and Kubernetes products can always connect regardless of the CIDR setting; the allowlist only affects external access. Adjustments are non-disruptive (no downtime).

---

#### MySQL Economy (`mysqldatabase`)

```bash
# 1. Create
nctl create mysqldatabase <service-name>

# 2. Get credentials
FQDN=$(nctl get mysqldatabase <service-name>)
USER=$(nctl get mysqldatabase <service-name> --print-user)
PASS=$(nctl get mysqldatabase <service-name> --print-password)

# 3. Inject
nctl update app <app-name> \
  --env=DATABASE_URL=mysql2://${USER}:${PASS}@${FQDN}:3306/${USER}

# 4. (Optional) CA cert
nctl get mysqldatabase <service-name> --print-ca-cert > mysql-ca.pem
```

**Economy sizing:** Automatic S/M/L, max 10 GB. No --allowed-cidrs on Economy tier.

---

#### MySQL Business (`mysql`)

```bash
# 1. Create — allow all IPs by convention; TLS + credentials provide security
nctl create mysql <service-name> \
  --machine-type=nine-db-s \
  --allowed-cidrs=0.0.0.0/0

# 2. Get credentials
FQDN=$(nctl get mysql <service-name>)
USER=$(nctl get mysql <service-name> --print-user)
PASS=$(nctl get mysql <service-name> --print-password)

# 3. Inject
nctl update app <app-name> \
  --env=DATABASE_URL=mysql2://${USER}:${PASS}@${FQDN}:3306/${USER}

# 4. IP allowlist update (post-creation)
nctl update mysql <service-name> --allowed-cidrs=203.0.113.1/32
```

**MySQL version:** Only MySQL 8 is available. Same machine types as PostgreSQL Business.

---

#### KVS — Redis-compatible Key-Value Store (`keyvaluestore`)

```bash
# 1. Create — allow all IPs by convention; TLS + token provide security
nctl create keyvaluestore <service-name> --allowed-cidrs=0.0.0.0/0

# 2. Get connection details
FQDN=$(nctl get keyvaluestore <service-name>)
TOKEN=$(nctl get keyvaluestore <service-name> --print-token)

# 3. Inject into app — TLS is mandatory, use rediss:// scheme
nctl update app <app-name> \
  --env=REDIS_URL=rediss://:${TOKEN}@${FQDN}:6379

# 4. (Optional) Get CA cert for strict TLS verification
nctl get keyvaluestore <service-name> --print-ca-cert > kvs-ca.pem

# 5. Test connectivity manually (TLS + skip hostname check for self-signed cert)
REDISCLI_AUTH="${TOKEN}" redis-cli --tls --insecure -h ${FQDN}
```

**Sizing options:**
| RAM | Disk | Notes |
|---|---|---|
| 256 MB | 512 MB | Dev/staging |
| 1 GB | 2 GB | Small production |
| 2 GB | 4 GB | Medium production |
| Custom | RAM × 2 | Contact Nine for larger sizes |

Sizing is configured post-creation via Cockpit or API — no flag on `nctl create`.

**TLS details:**
- Port: `6379` (standard Redis port, TLS wraps it)
- TLS is mandatory and uses a self-signed certificate
- Hostname verification must be disabled (`--insecure` or `skip_verify` in config)
- Use `rediss://` (double-s) scheme in connection URLs to enable TLS
- `FLUSHALL` is prohibited — use `FLUSHDB` instead
- Default maxmemory policy: `allkeys-lru`

**Proactive coordinator message:** *"I'll inject `REDIS_URL` with TLS (`rediss://`) — this is required since the KVS only accepts TLS connections. If you're using Sidekiq, I can also set up a worker job at the same time."*

---

#### OpenSearch (beta) (`opensearch`)

```bash
# 1. Create (allow all IPs by convention — TLS + credentials provide security)
nctl create opensearch <service-name> --allowed-cidrs=0.0.0.0/0

# 2. Get connection details
FQDN=$(nctl get opensearch <service-name>)
USER=$(nctl get opensearch <service-name> --print-user)
TOKEN=$(nctl get opensearch <service-name> --print-token)

# 3. Get CA cert
nctl get opensearch <service-name> --print-ca-cert > opensearch-ca.pem

# 4. Inject into app
nctl update app <app-name> \
  --env=OPENSEARCH_URL=https://${USER}:${TOKEN}@${FQDN}:443

# 5. Test connectivity
curl -XGET "https://${FQDN}/_cluster/health" -sku "${USER}:${TOKEN}"

# 6. (Optional) Grant bucket user access to snapshots
nctl update opensearch <service-name> --bucket-users <bucket-user-name>
```

**Machine types (sizing):**
| Type | vCPU | RAM | Storage |
|---|---|---|---|
| `nine-search-xs` | 2 | 2 GB | 10 GB |
| `nine-search-s` | 2 | 4 GB | 20 GB |
| `nine-search-m` | 4 | 8 GB | 60 GB |
| `nine-search-l` | 4 | 16 GB | 120 GB |
| `nine-search-xl` | 8 | 32 GB | 200 GB |

**Beta warning:** Resource management via Cockpit or nctl may be limited during the beta period. Confirm with Nine support before using in production.

---

#### S3-Compatible Object Storage (`bucket` + `bucketuser`)

Object storage uses two separate resources: a `bucket` (the storage container) and a `bucketuser` (the IAM identity with access credentials).

```bash
# 1. Create bucket — --location is required
#    Locations: nine-cz41 (Prague), nine-cz42 (Prague alt), nine-es34 (Barcelona)
nctl create bucket <service-name> --location=nine-cz41

# 2. Create bucket user (credentials holder)
nctl create bucketuser <service-name>-user --location=nine-cz42

# 3. Grant bucket user access to the bucket
#    (Permissions: read, write, readwrite — set via --permissions flag on bucket)
nctl update bucket <service-name> --permissions=<service-name>-user:readwrite

# 4. Get bucket user credentials (access key + secret key)
nctl get bucketuser <service-name>-user -o yaml
# → Look for accessKey and secretKey fields

# 5. Reset credentials if needed
nctl update bucketuser <service-name>-user --reset-credentials

# 6. Inject into app
#    Endpoint format: <location>.objects.nineapis.ch
#    Region is always "us-east-1" regardless of physical location
nctl update app <app-name> \
  --env=AWS_ACCESS_KEY_ID=<access-key> \
  --env=AWS_SECRET_ACCESS_KEY=<secret-key> \
  --env=AWS_REGION=us-east-1 \
  --env=S3_BUCKET=<service-name> \
  --env=S3_ENDPOINT=https://cz41.objects.nineapis.ch \
  --env=S3_REGION=us-east-1
```

**Endpoints by location:**
| Location | Endpoint |
|---|---|
| `nine-cz41` | `cz41.objects.nineapis.ch` |
| `nine-cz42` | `cz42.objects.nineapis.ch` |
| `nine-es34` | `es34.objects.nineapis.ch` |

Both path-style (`https://cz41.objects.nineapis.ch/bucket-name`) and host-style (`https://bucket-name.cz41.objects.nineapis.ch`) URLs are supported.

**Rails Active Storage note:** Set `force_path_style: true` in `config/storage.yml` and use the S3 adapter pointing to the Nine endpoint. See `skills/deploio-provision/references/rails-wiring.md`.

**Proactive coordinator message:** *"I'll create both a bucket and a bucket user (the credentials holder), then inject `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, and `S3_ENDPOINT` into your app. For Rails, I'll also configure Active Storage to use path-style URLs — required for Nine's S3 API."*

---

### Env var injection summary

Deploio does **not** auto-inject any environment variables when a service is provisioned. The coordinator agent must always extract credentials and inject them manually:

| Service | Env vars to inject |
|---|---|
| PostgreSQL (any tier) | `DATABASE_URL` |
| MySQL (any tier) | `DATABASE_URL` |
| KVS | `REDIS_URL` (must use `rediss://` scheme) |
| OpenSearch | `OPENSEARCH_URL` |
| Bucket | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET`, `S3_ENDPOINT` |

**Env var flag syntax:** `nctl update app <name> --env=KEY=VALUE --env=KEY2=VALUE2`

---

The executor reports back:
```json
{
  "status": "success | failed",
  "service_name": "<name>",
  "env_vars_injected": ["DATABASE_URL"],
  "error": null
}
```

Update the task: `TaskUpdate` with `status: completed` on success, `status: failed` on error.

---

## Phase 3: Verify the connection

After injection, spawn a **verifier agent** with `mode: bypassPermissions`:

```
task: verify-connection
app: <app-name>
service_type: <type>
termination: exit after one successful check or after 5 minutes
```

The agent retries `nctl exec` until the app replica is ready (it may be restarting after the env var change), then runs the appropriate check:

**PostgreSQL / MySQL:**
```bash
nctl exec app <app-name> -- rails runner "ActiveRecord::Base.connection.execute('SELECT 1')"
# or for non-Rails:
nctl exec app <app-name> -- env | grep DATABASE_URL
```

**KVS:**
```bash
nctl exec app <app-name> -- env | grep REDIS_URL
```

> Note: KVS verification confirms the env var is present. If the app reports Redis errors, check that the URL uses `rediss://` (double-s) — TLS is mandatory on port `6379`.

**OpenSearch:**
```bash
nctl exec app <app-name> -- env | grep OPENSEARCH_URL
```

**S3 / Bucket:**
```bash
nctl exec app <app-name> -- env | grep AWS_ACCESS_KEY_ID
```

> Note: Bucket verification confirms env vars are present. If uploads fail, verify `force_path_style: true` is set and the region is `us-east-1`.

On success:
> "Connection verified — `DATABASE_URL` is set and the app can reach PostgreSQL."

On timeout (5 min):
> "Connection check timed out — the env var is injected but I couldn't verify connectivity. Check app logs if you see DB errors."

---

## Phase 4: Next steps

After successful provisioning, offer context-relevant next steps:

```
PostgreSQL is live and wired to myapp.

What's next?
  → Run migrations      — I can trigger rake db:migrate via deploio-manage
  → Add a worker job    — for Sidekiq: nctl update app --worker-job-name=sidekiq --worker-job-command="bundle exec sidekiq"
  → Add Redis/KVS       — use deploio-provision for a keyvaluestore
  → Nothing for now     — you're all set!
```

---

## Worker jobs (Sidekiq, background processing)

Worker jobs run as separate processes sharing the app's image and environment. They are configured on the app, not as separate services.

```bash
# Add a worker job at app creation time
nctl create app <app-name> \
  --worker-job-name=sidekiq \
  --worker-job-command="bundle exec sidekiq" \
  --worker-job-size=mini

# Add a worker job to an existing app
nctl update app <app-name> \
  --worker-job-name=sidekiq \
  --worker-job-command="bundle exec sidekiq" \
  --worker-job-size=mini

# Worker job sizes: micro (256 MiB), mini (512 MiB), standard-1 (1 GiB), standard-2 (2 GiB)
# Maximum 3 worker jobs per app (only 1 during initial creation)
```

Workers share all env vars with the main app — if `REDIS_URL` is injected, Sidekiq picks it up automatically.

---

## Rails-specific wiring

If the user has a Rails app that needs Sidekiq or Active Storage wired up after provisioning, read `skills/deploio-provision/references/rails-wiring.md` for initializer and config file content.

---

## Managing services

```bash
# List all services
nctl get postgresdatabase
nctl get postgresql
nctl get mysqldatabase
nctl get mysql
nctl get keyvaluestore
nctl get opensearch
nctl get bucket
nctl get bucketuser

# Inspect a service
nctl get postgresdatabase <name> -o yaml
nctl get postgresql <name> -o yaml

# Update IP allowlist (Business tier PostgreSQL/MySQL only)
nctl update postgresql <name> --allowed-cidrs=203.0.113.1/32,10.0.0.0/8

# Delete (IRREVERSIBLE — always confirm with user first)
nctl delete postgresdatabase <name>
nctl delete postgresql <name>
nctl delete keyvaluestore <name>
nctl delete bucket <name>
nctl delete bucketuser <name>
```

**Always confirm with the user before running `nctl delete` on any service.** Deletion is permanent and data will be lost.

---

## Common provisioning issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `PG::ConnectionBad` after injection | App not yet restarted after env var change | Trigger `--retry-release` via deploio-manage |
| `REDIS_URL` set but Sidekiq not connecting | Wrong URL scheme | Ensure `rediss://` (double-s) and port `6379` — TLS is mandatory |
| `redis-cli` can't connect | Hostname verification fails on self-signed cert | Add `--tls --insecure` flags |
| Bucket upload fails | Missing `force_path_style` | Add `force_path_style: true` to Active Storage config |
| Bucket upload fails | Wrong region | Region must always be `us-east-1` regardless of physical location |
| Can't connect to DB from local machine | IP not in allowlist | `nctl update postgresql <name> --allowed-cidrs=<your-ip>/32` (Business tier only) |
| Economy DB: can't add IP allowlist | Economy tier doesn't support `--allowed-cidrs` | Use Business tier (`postgresql`) for direct external access |
| OpenSearch unreachable | Beta limitations | Confirm via Nine support portal; check `--allowed-cidrs` |
| Service created but env var not injected | Executor interrupted | Re-run injection: `nctl update app <app> --env=KEY=VALUE` |
| `nctl create kvs` — resource not found | Wrong resource name | The correct name is `keyvaluestore`, not `kvs` |
| `nctl create postgresql` vs `postgresdatabase` | Tier mismatch | Economy = `postgresdatabase`; Business = `postgresql` |
