#!/usr/bin/env bash
# Proves a backup can be restored: dumps DATABASE_URL, restores into a scratch
# database on the same server, and compares row counts, migrations and the
# append-only triggers. Read-only toward the source. Usage: npm run db:restore-drill
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
scratch="relay_restore_drill_$$"
admin="${DATABASE_URL%/*}/postgres"
target="${DATABASE_URL%/*}/$scratch"
dump="$(mktemp)"
cleanup() { rm -f "$dump"; psql "$admin" -qc "DROP DATABASE IF EXISTS $scratch" >/dev/null 2>&1 || true; }
trap cleanup EXIT
pg_dump --format=custom --no-owner --file="$dump" "$DATABASE_URL"
psql "$admin" -qc "CREATE DATABASE $scratch" >/dev/null
pg_restore --no-owner --exit-on-error --dbname="$target" "$dump"
count() { psql "$1" -Atc "SELECT string_agg(t||'='||c, ',' ORDER BY t) FROM (
  SELECT relname t, (xpath('/row/c/text()', query_to_xml('SELECT count(*) c FROM '||quote_ident(relname), false, true, '')))[1]::text::int c
  FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace) x"; }
a="$(count "$DATABASE_URL")"; b="$(count "$target")"
[ "$a" = "$b" ] || { echo "FAIL: row counts differ after restore"; exit 1; }
m1="$(psql "$DATABASE_URL" -Atc "SELECT max(version) FROM schema_migrations")"
m2="$(psql "$target" -Atc "SELECT max(version) FROM schema_migrations")"
[ "$m1" = "$m2" ] || { echo "FAIL: migration version differs"; exit 1; }
armed="$(psql "$target" -Atc "SELECT count(*) FROM pg_trigger WHERE tgname='immutable_audit' AND tgenabled='O'")"
[ "$armed" = "1" ] || { echo "FAIL: append-only audit trigger missing after restore"; exit 1; }
echo "OK: restored $(stat -c %s "$dump") bytes; migrations $m2; row counts and audit trigger match."
