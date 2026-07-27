#!/bin/sh
# Apply pending DB migrations, then exec the given command (the server).
# Migrations are idempotent (schema_migrations tracking table), so this is safe
# to run on every container start. If a migration fails, migrate.js exits 1 and
# `set -e` aborts before the server starts — we never serve on a half-migrated DB.
set -e

# migrate.js refuses to touch a REMOTE database without confirmation, so that a
# stray `npm run migrate` on a developer's machine cannot alter production. This
# is the opposite case: the deployment applying its own schema, on its own
# database, with no terminal to answer on. Confirm it explicitly here — the guard
# stays in force everywhere a human runs the script by hand.
export CONFIRM_REMOTE_DB=1

echo "[entrypoint] running migrations..."
node scripts/migrate.js

echo "[entrypoint] starting: $*"
exec "$@"
