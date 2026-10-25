#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$root"
test -f compose.yaml && test -f compose.vps.yaml && test -f compose.https.yaml && test -f .env
store="$root/.backups/automatic"
mkdir -p "$store"
chmod 700 "$store"
exec 9>"$store/.lock"
flock -n 9 || exit 0
available=$(df -Pk "$store" | awk 'NR == 2 { print $4 }')
if (( available < 102400 )); then echo 'Backup refused: less than 100 MiB free' >&2; exit 1; fi
name="auto-$(date -u +%Y%m%dT%H%M%SZ)-$$"
work="$store/.partial-$name"
mkdir -m 700 "$work"
trap 'rm -rf -- "$work"' EXIT
compose=(docker compose -f compose.yaml -f compose.vps.yaml -f compose.https.yaml --profile app)
"${compose[@]}" exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' </dev/null > "$work/database.dump"
"${compose[@]}" exec -T postgres pg_restore -l < "$work/database.dump" > "$work/database.contents"
tar -czf "$work/source.tar.gz" --exclude='./.backups' --exclude='node_modules' --exclude='*/node_modules' --exclude='*/dist' --exclude='*/generated' --exclude='./.git' --exclude='.env*' --exclude='*.tar.gz' --exclude='stage*-check.html' .
cp -p .env "$work/server.env"
"${compose[@]}" exec -T caddy tar -czf - -C /data . </dev/null > "$work/caddy-data.tar.gz"
"${compose[@]}" images --format json </dev/null > "$work/images.json"
(cd "$work" && sha256sum database.dump source.tar.gz server.env caddy-data.tar.gz > SHA256SUMS)
chmod 600 "$work"/*
mv -- "$work" "$store/$name"
# Only snapshots created by this script in its dedicated directory expire.
find "$store" -mindepth 1 -maxdepth 1 -type d -name 'auto-*' -mtime +6 -exec rm -rf -- {} +
echo "BACKUP_OK $store/$name"
