#!/bin/sh
set -e
case "$1" in
  web) cd /app/apps/web && exec node_modules/.bin/next start -p "${PORT:-3000}" ;;
  worker) cd /app && exec node apps/worker/dist/index.js ;;
  migrate) cd /app && exec node packages/server/dist/db/migrate.js ;;
  seed) cd /app && exec node packages/server/dist/db/seed.js ;;
  selfcheck) cd /app/packages/pipeline && exec node dist/cli.js selfcheck --fixtures /app/fixtures --work /tmp/selfcheck ;;
  *) exec "$@" ;;
esac
