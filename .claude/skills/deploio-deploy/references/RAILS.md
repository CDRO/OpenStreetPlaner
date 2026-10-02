# Deploio Framework Defaults: Rails

## Plan card defaults (show to user in Phase 3)

Rails defaults (auto-configured, no action needed):

| Env / Setting | Value |
|---|---|
| RAILS_ENV | production |
| RAILS_SERVE_STATIC_FILES | true |
| SECRET_KEY_BASE | auto-generated |
| Deploy job | rake db:prepare (runs migrations before each release) |

## Instance size

Default: **`mini`** (512 MiB RAM, 0.25 CPU).
Rails apps routinely OOM on `micro` during boot (asset precompilation, Spring). Upgrade to `standard-1` if the app uses heavy gems (nokogiri, sassc) or serves significant traffic.

## Port

`3000`

## Required env vars (set at creation)

```bash
RAILS_ENV=production
SECRET_KEY_BASE=<generate with: openssl rand -hex 64 — never ask the user>
RAILS_SERVE_STATIC_FILES=true
```

Optional:
```bash
RAILS_MASTER_KEY=<contents of config/master.key, if the file exists>
```

> `RAILS_SERVE_STATIC_FILES` is required on Deploio because there is no Nginx in front of the Puma process. Without it, asset requests (CSS, JS) return 404.

## Deploy job

Add if `db/migrate/` exists in the repo:
```bash
--deploy-job-command="bundle exec rake db:prepare"
--deploy-job-name="migrate-database"
--deploy-job-timeout=10m
--deploy-job-retries=3
```

`rake db:prepare` is idempotent: creates the database if absent, runs pending migrations if it exists — safe for both first deploy and subsequent releases.

## Health probe

Rails 7.1+ ships a built-in `/up` endpoint. Set:
```bash
--health-probe-path="/up"
```

For older Rails, suggest adding a minimal health controller:
```ruby
# config/routes.rb
get "/up", to: proc { [200, {}, ["ok"]] }
```

## Sidekiq detection

If `Gemfile` contains `sidekiq`, note at plan-card time:
> "I see you're using Sidekiq — that needs a Redis KVS and a worker job. I can provision both once the app is live, or set up the worker job now if you already have Redis."

Worker job command: `bundle exec sidekiq`
Recommended worker size: `mini`

## SolidQueue (alternative to Sidekiq)

If `Gemfile` contains `solid_queue`, SolidQueue can run inside the web process (no separate worker container needed). Mention this as a cost-saving option:
> "SolidQueue can run inside your web process using a Rails initializer — no separate worker container needed, which saves ~CHF 16/month."

## .deploio.yaml template (for teams — only if asked)

Only offer this if the user is setting up a shared/team project or explicitly asks. Do not volunteer it on simple first-deploys.

```yaml
# .deploio.yaml — tracked in git, synced with Deploio config
deployJob:
  command: bundle exec rake db:prepare
  name: migrate-database
  timeout: 10m
  retries: 3
size: mini
replicas: 1
healthProbe:
  path: /up
```

## Build performance notes

- **Buildpack** (default): slow on first build; uses Heroku Ruby buildpack; no layer caching
- **Dockerfile**: faster after first build due to layer caching. Check that `.dockerignore` excludes `node_modules/`, `vendor/`, `tmp/`, `log/` to keep the build context small
- If the user complains about slow builds, ask whether they have a `Dockerfile` — it significantly speeds up subsequent builds

## Common Rails deploy issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `KeyError: key not found: "SECRET_KEY_BASE"` | Env var not set | Generate with `openssl rand -hex 64` and inject |
| Assets return 404 | `RAILS_SERVE_STATIC_FILES` not set | Add `--env=RAILS_SERVE_STATIC_FILES=true` |
| `PG::ConnectionBad` | `DATABASE_URL` not set | Provision PostgreSQL via deploio-provision |
| Deploy job times out | Slow migrations | Increase `--deploy-job-timeout=20m` |
| OOM / exit 137 on boot | `micro` size too small | Upgrade to `mini` or `standard-1` |
| Spring preloader OOM | Spring running in production | Add `DISABLE_SPRING=1` env var |
