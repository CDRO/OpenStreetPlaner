# Deploio Framework Defaults: Python (Django / Flask / FastAPI)

## Detection

| File present | Framework | Port |
|---|---|---|
| `manage.py` + `requirements.txt` or `pyproject.toml` | Django | 8000 |
| `app.py` or `main.py` + `requirements.txt` | Flask / FastAPI | 8000 |

## Instance size

Default: **`micro`** (256 MiB RAM, 0.125 CPU). Sufficient for most Python apps. Upgrade to `mini` if the app loads large ML models or uses heavy in-memory caches.

## Port

`8000` (Gunicorn/Uvicorn default). Deploio injects `PORT` — ensure the start command uses it:
```
gunicorn myapp.wsgi:application --bind 0.0.0.0:$PORT
uvicorn main:app --host 0.0.0.0 --port $PORT
```

---

## Django

### Required env vars

```bash
DJANGO_SECRET_KEY=<generate a random 50-char string>
ALLOWED_HOSTS=*
```

> Update `ALLOWED_HOSTS` after deploy with the live Deploio hostname (e.g. `myapp.deploio.app`), or use a package like `django-environ` to read from an env var.

### Deploy job

Add if `manage.py migrate` is needed:
```bash
--deploy-job-command="python manage.py migrate --noinput"
--deploy-job-name="migrate-database"
```

### Static files

Django requires `collectstatic` before serving assets. Either:
- Run as part of the build step (add to `Procfile` or Dockerfile `RUN` step), or
- Add to the deploy job: `python manage.py collectstatic --noinput && python manage.py migrate --noinput`

Set `STATIC_ROOT` and use `whitenoise` for in-process static file serving (no Nginx needed on Deploio).

### Health probe

Add a simple view: `GET /health` → 200. Set `--health-probe-path="/health"`.

---

## Flask / FastAPI

### Required env vars

```bash
SECRET_KEY=<generate a random secret>
```

### Deploy job

Usually none unless using Alembic migrations:
```bash
--deploy-job-command="flask db upgrade"
--deploy-job-name="migrate-database"
```

---

## Common Python deploy issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `ModuleNotFoundError` | Missing `requirements.txt` or wrong pip install | Commit `requirements.txt`; check buildpack Python detection |
| `DisallowedHost` (Django) | `ALLOWED_HOSTS` too strict | Set `ALLOWED_HOSTS=*` initially, then restrict after deploy |
| Static files 404 (Django) | `collectstatic` not run | Add to deploy job or Dockerfile |
| App crashes on boot | Wrong `PORT` binding | Use `--bind 0.0.0.0:$PORT` in gunicorn/uvicorn command |
