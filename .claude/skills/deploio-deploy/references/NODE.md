# Deploio Framework Defaults: Node.js

## Instance size

Default: **`micro`** (256 MiB RAM, 0.125 CPU).
Upgrade to `mini` for Next.js SSR apps or apps with significant in-process state.

## Port

`3000` (Express, Next.js, NestJS default). Check `package.json` start script for overrides — some apps use `8080` or read `process.env.PORT` (which Deploio sets automatically).

> Deploio injects `PORT` as an env var — ensure the app listens on `process.env.PORT`, not a hardcoded value.

## Required env vars (set at creation)

```bash
NODE_ENV=production
```

Optional (Next.js):
```bash
NEXT_TELEMETRY_DISABLED=1
```

## Deploy job

Usually none. If the app has a DB migration step (Prisma, Sequelize, Knex), add:
```bash
--deploy-job-command="npx prisma migrate deploy"
--deploy-job-name="migrate-database"
```

## Build env vars (build-time only)

If the app uses a build step (`npm run build`), set any build-time config via `--build-env`:
```bash
--build-env=NODE_VERSION=20
```

## Health probe

No universal default. Suggest adding a `/health` endpoint or use `--health-probe-path="/"` if the root returns 200.

## Common Node.js deploy issues

| Symptom | Likely cause | Fix |
|---|---|---|
| App crashes immediately | Hardcoded port | Listen on `process.env.PORT` |
| Build fails | Missing `package-lock.json` | Commit the lock file |
| `npm run start` not found | Wrong start script | Check `scripts.start` in `package.json` |
| Memory exceeded | `micro` too small for Next.js | Upgrade to `mini` |
