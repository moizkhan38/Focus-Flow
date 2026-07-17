#!/bin/sh
# Apply pending DB migrations, then exec the given command (the server).
# Migrations are idempotent (schema_migrations tracking table), so this is safe
# to run on every container start. If a migration fails, migrate.js exits 1 and
# `set -e` aborts before the server starts — we never serve on a half-migrated DB.
set -e

echo "[entrypoint] running migrations..."
node scripts/migrate.js

echo "[entrypoint] starting: $*"
exec "$@"
