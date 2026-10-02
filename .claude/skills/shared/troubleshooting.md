# Deploio Troubleshooting Reference

Common problems, their root causes, and how to fix them. Referenced by `deploio-deploy` (first-deploy issues) and `deploio-debug` (runtime diagnostics).

---

## Build failures

| Symptom | Likely cause | Fix |
|---|---|---|
| Build fails immediately | Lock file not committed (`Gemfile.lock`, `package-lock.json`) | Commit the lock file and retry (`--retry-build`) |
| Build times out (> 20 min) | Large dependencies or slow first build | Retry; if persistent, use `--size flex-4` for the build |
| `BUNDLE_GEMFILE` / missing gems error | `Gemfile.lock` out of date or missing | Run `bundle install` locally, commit `Gemfile.lock`, retry build |
| Build log missing | Build not yet started | Use `nctl logs build <app-name> -a` — fetches the latest build automatically |

## Deploy job / migration failures

| Symptom | Check | Fix |
|---|---|---|
| Deploy job timeout | Deploy job logs | Increase `--deploy-job-timeout=15m`; check migration for table locks |
| Deploy job not running at all | App config (`-o yaml`) | Always include `--deploy-job-enabled` when configuring the job |
| Migration failed transiently | Deploy job logs | Use `--retry-release` to re-run release without rebuilding |

## Boot / startup failures

| Symptom | Check | Fix |
|---|---|---|
| `SECRET_KEY_BASE not set` | App logs | `nctl update app <name> --project <project> --env=SECRET_KEY_BASE=$(rails secret)` |
| App crashes on start | App logs | Look for `KeyError` or `NameError`; add the missing env var |
| Build succeeds, release crashes | `--type app` logs | Check for boot errors, missing env vars |
| SSL redirect loop | App behaviour | Add `config.assume_ssl = true` to `production.rb` |
| `ALLOWED_HOSTS` error (Django) | App logs | Update `ALLOWED_HOSTS` env var with the live Deploio hostname |

## Runtime / network errors

| Symptom | Check | Fix |
|---|---|---|
| 502 Bad Gateway | App config | Set `--port=` to the port the app actually binds |
| 503 Service Unavailable / Bad Gateway | App logs + `-o stats` | App may be restarting — check restart count and boot errors |
| `PG::ConnectionBad` | App logs | Verify `DATABASE_URL` is set and includes `?sslmode=verify-full` |
| Replica keeps restarting | `-o stats` restart count + LASTEXITCODE | Exit code 137 = OOM or 2GiB ephemeral storage exceeded — upsize with `--size=standard-1` |
| Worker not processing jobs | `--type worker_job` logs | Verify `REDIS_URL` uses `rediss://` (double-s), port `6380`; check worker logs |

## Domain and SSL

| Symptom | Check | Fix |
|---|---|---|
| Custom domain not resolving | DNS config | Run `nctl get app <name> --dns`, set CNAME/TXT at registrar |
| SSL cert not provisioning | `-o yaml` cert status | DNS records must propagate first — cert follows automatically |

## Git / auth errors

| Symptom | Likely cause | Fix |
|---|---|---|
| Auth error on git pull | Private repo, no credentials | Add SSH key (`--git-ssh-private-key-from-file`) or HTTPS token (`--git-username`/`--git-password`) |
