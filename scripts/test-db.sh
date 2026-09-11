#!/usr/bin/env bash
# Start a throwaway PostgreSQL cluster for integration tests.
#
# CI uses a service container instead (see .github/workflows/ci.yml); this is
# for running the suite locally and in sandboxes where no server is running.
#
#   ./scripts/test-db.sh start   -> prints the connection URLs
#   ./scripts/test-db.sh stop
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGDIR="${PGDIR:-/tmp/sinclair-testdb}"
PGDB="${PGDB:-sinclair_test}"
PGPORT="${PGPORT:-55432}"

as_postgres() {
  if [ "$(id -u)" -eq 0 ]; then su postgres -c "PATH=$PGBIN:\$PATH $1"; else bash -lc "PATH=$PGBIN:\$PATH $1"; fi
}

case "${1:-start}" in
  start)
    if [ -f "$PGDIR/data/postmaster.pid" ]; then
      echo "already running" >&2
    else
      rm -rf "$PGDIR"; mkdir -p "$PGDIR"
      [ "$(id -u)" -eq 0 ] && chown postgres:postgres "$PGDIR"
      as_postgres "initdb -D $PGDIR/data -U postgres --auth=trust" >/dev/null
      as_postgres "pg_ctl -D $PGDIR/data -o \"-k $PGDIR -p $PGPORT -c listen_addresses=127.0.0.1 -c fsync=off\" -l $PGDIR/log start" >/dev/null
      for _ in $(seq 1 20); do
        as_postgres "psql -h 127.0.0.1 -p $PGPORT -U postgres -c 'select 1'" >/dev/null 2>&1 && break
        sleep 0.3
      done
      as_postgres "psql -h 127.0.0.1 -p $PGPORT -U postgres -c 'CREATE DATABASE $PGDB'" >/dev/null
    fi
    # Written to a gitignored file so `npm test` works without the caller
    # having to keep the URLs exported in their shell.
    cat > .env.test.local <<ENV
DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:$PGPORT/$PGDB
DATABASE_URL=postgres://app_user@127.0.0.1:$PGPORT/$PGDB
ENV
    echo "export DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:$PGPORT/$PGDB"
    echo "export DATABASE_URL=postgres://app_user@127.0.0.1:$PGPORT/$PGDB"
    ;;
  stop)
    as_postgres "pg_ctl -D $PGDIR/data stop" >/dev/null 2>&1 || true
    rm -rf "$PGDIR" .env.test.local
    ;;
  *) echo "usage: $0 {start|stop}" >&2; exit 1 ;;
esac
