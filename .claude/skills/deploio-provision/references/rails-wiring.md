# Rails-Specific Wiring for Deploio Backing Services

Post-provisioning configuration steps for Rails apps. Read this when the user has a Rails app and has just provisioned KVS or Bucket services.

---

## Sidekiq (after KVS provisioning)

Add an initializer that reads `REDIS_URL` (already injected by deploio-provision):

```ruby
# config/initializers/sidekiq.rb
Sidekiq.configure_server { |c| c.redis = { url: ENV['REDIS_URL'] } }
Sidekiq.configure_client { |c| c.redis = { url: ENV['REDIS_URL'] } }
```

Then add the Sidekiq worker process via deploio-manage:

```bash
nctl update app <name> --project <project> \
  --worker-job-name=sidekiq \
  --worker-job-command="bundle exec sidekiq" \
  --worker-job-size=mini
```

## Active Storage (after Bucket provisioning)

Configure Active Storage to use the Deploio bucket (S3-compatible):

```yaml
# config/storage.yml
deploio:
  service: S3
  access_key_id: <%= ENV['AWS_ACCESS_KEY_ID'] %>
  secret_access_key: <%= ENV['AWS_SECRET_ACCESS_KEY'] %>
  region: <%= ENV['AWS_REGION'] %>
  bucket: <%= ENV['S3_BUCKET'] %>
  endpoint: <%= ENV['S3_ENDPOINT'] %>
  force_path_style: true
```

Then set the storage service in `config/environments/production.rb`:

```ruby
config.active_storage.service = :deploio
```

> `force_path_style: true` is required — Deploio's S3-compatible storage uses path-style URLs, not subdomain-style.
