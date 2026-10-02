# Deploio Framework Defaults: Custom Dockerfile

## When this applies

A `Dockerfile` is present in the repo root (or at a specified path). Use `--dockerfile` flag with `nctl create app`.

## Instance size

Default: **`mini`** (512 MiB RAM, 0.25 CPU) — unknown footprint. Ask the user or default conservatively. Adjust after first deploy based on observed memory usage (`nctl get app <name> -o stats`).

## Port

Read the `EXPOSE` line in the Dockerfile:
```dockerfile
EXPOSE 8080   # → use --port=8080
```

If no `EXPOSE` line exists, ask the user what port the app listens on.

## Required env vars

None injected by default. Consult the app's own documentation or `README` for required vars.

## Build flags

```bash
nctl create app <name> \
  --dockerfile \
  [--dockerfile-path=<path>]              # if Dockerfile is not at repo root
  [--dockerfile-build-context=<path>]     # if build context differs from Dockerfile location
  [--build-env=BUILD_ARG=value]           # Docker build args (ARG in Dockerfile)
```

## Performance

Docker builds use **layer caching** — subsequent builds are significantly faster than buildpack builds, as only changed layers are rebuilt. For fast iteration, recommend Dockerfile over buildpacks.

**Key `.dockerignore` entries to include** (reduces build context size and speeds up image transfers):
```
node_modules/
vendor/
.git/
tmp/
log/
*.log
.env
```

Warn the user if these are missing from `.dockerignore`.

## Deploy job

App-specific. Ask the user if they need migrations or setup steps to run before each release.

## Health probe

Read from the Dockerfile or app documentation. No universal default — ask the user:
> "Does your app expose a health check endpoint (e.g. `/health`, `/ping`)? I can configure Deploio to poll it before marking the release as healthy."

## Common Dockerfile deploy issues

| Symptom | Likely cause | Fix |
|---|---|---|
| Port mismatch (502) | `EXPOSE` doesn't match app's actual port | Verify the app's listen port and use `--port=<correct>` |
| Slow builds | Large build context | Add `.dockerignore` with `node_modules/`, `vendor/`, `.git/` |
| Build fails on `RUN apt-get` | Missing `apt-get update` before install | Add `RUN apt-get update && apt-get install -y ...` |
| Image too large | No multi-stage build | Suggest multi-stage: build in one stage, copy binary to minimal base |
| Build ARGs not passed | Missing `--build-env` | Pass build-time args with `--build-env=KEY=VALUE` |
