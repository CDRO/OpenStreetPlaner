# Deploio Framework Defaults: Go

## Detection

`go.mod` present in repo root.

## Instance size

Default: **`micro`** (256 MiB RAM, 0.125 CPU). Go binaries are lean — `micro` is almost always sufficient. Upgrade only if the app handles high concurrency or large in-memory datasets.

## Port

`8080` (common Go default). Go apps must listen on `process.env.PORT` (or the equivalent — Deploio injects `PORT`):
```go
port := os.Getenv("PORT")
if port == "" {
    port = "8080"
}
http.ListenAndServe(":"+port, nil)
```

## Required env vars

None required by default. Go apps typically configure themselves via env vars defined by the app author.

## Deploy job

Usually none. If using a DB migration tool (golang-migrate, goose), add:
```bash
--deploy-job-command="./migrate -path db/migrations -database $DATABASE_URL up"
--deploy-job-name="migrate-database"
```

## Build env vars

Go version can be pinned via build env:
```bash
--build-env=GO_VERSION=1.22
```

## Health probe

No universal default. Suggest `--health-probe-path="/health"` and ensure the app exposes it:
```go
http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
})
```

## Common Go deploy issues

| Symptom | Likely cause | Fix |
|---|---|---|
| Build fails: module not found | `go.sum` not committed | Run `go mod tidy` and commit |
| Port binding error | Hardcoded port | Read `PORT` from env |
| Binary not found | Wrong `GOARCH`/`GOOS` | Buildpack handles this — if using Dockerfile, build for `linux/amd64` |
