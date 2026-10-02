# Deploio Framework Defaults: PHP (Laravel / Symfony / plain PHP)

## Detection

`composer.json` present in repo root.

## Instance size

Default: **`micro`** (256 MiB RAM, 0.125 CPU). Upgrade to `mini` for Laravel apps with queue workers or heavy middleware.

## Port

`8080` (PHP-FPM / Apache default on buildpacks). Check the `Dockerfile` `EXPOSE` line if a custom image is used.

---

## Laravel

### Required env vars

```bash
APP_ENV=production
APP_KEY=<generate with: php artisan key:generate --show>
APP_DEBUG=false
```

> Generate `APP_KEY` by running `php artisan key:generate --show` locally — never leave it unset in production.

### Deploy job

Add if `database/migrations/` exists:
```bash
--deploy-job-command="php artisan migrate --force"
--deploy-job-name="migrate-database"
```

### Cache / config

Laravel's config and route caches improve performance in production. Add to deploy job if desired:
```bash
php artisan config:cache && php artisan route:cache && php artisan migrate --force
```

### Health probe

Laravel 11+ ships `/up`. For older versions, add a route and set `--health-probe-path="/up"`.

### Queue workers

Laravel queues (Horizon, default queue driver) need a worker job:
```bash
--worker-job-name=queue
--worker-job-command="php artisan queue:work --sleep=3 --tries=3"
--worker-job-size=micro
```

---

## Symfony

### Required env vars

```bash
APP_ENV=prod
APP_SECRET=<generate a random 32-char hex string>
```

### Deploy job

```bash
--deploy-job-command="php bin/console doctrine:migrations:migrate --no-interaction"
--deploy-job-name="migrate-database"
```

---

## Common PHP deploy issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `APP_KEY` not set error | Missing env var | Generate with `php artisan key:generate --show` |
| 500 on first request | `APP_DEBUG=true` hiding real error | Set `APP_DEBUG=false`, check logs |
| Storage write errors | Ephemeral filesystem | Use S3-compatible object storage (deploio-provision) |
| `composer install` fails | `composer.lock` not committed | Commit the lock file |
