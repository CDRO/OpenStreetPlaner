# Deploio Configuration Layers

Deploio config flows in a hierarchy: **Organization → Project → App**. Settings at lower layers override those above.

## Project-wide defaults

Useful for env vars that apply to all apps in the project (e.g. `RAILS_ENV`, default instance size):

```bash
# Set project-wide defaults (all apps inherit these unless overridden at app level)
nctl create config --env=RAILS_ENV=production -p <project>
nctl create config --size=mini -p <project>

# Update an existing project config
nctl update config --env=KEY=VALUE -p <project>
nctl update config --size=standard -p <project>

# View current project config
nctl get config -p <project> -o yaml
```

## App-level overrides

Any `nctl update app --env=...` or `--size=...` call sets app-level values that override the project config for that specific app only. App-level settings always win.

## When to use project config vs app config

| Use project config for | Use app config for |
|---|---|
| Shared env vars across all apps (`RAILS_ENV`, `NODE_ENV`) | App-specific credentials and connection URLs |
| Default instance size for the project | Overriding size for one specific app |
| Shared build defaults | App-specific build env vars |
