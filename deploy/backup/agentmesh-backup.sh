#!/usr/bin/env bash
# AgentMesh: off-site backups of the hub (docs/deploy.md#off-site-backups). A systemd timer runs it
# every hour on the hub server:
#
#   agentmesh-backup run      # snapshot the database, bundle it with the files needed to rebuild
#                             # the hub, encrypt to AGE_RECIPIENT, push to BACKUP_REMOTE
#   agentmesh-backup status   # when the last copies were pushed
#
# The backup repository holds one file, hub-backup.tar.gz.age, on two branches: `main` gets one
# commit per UTC day (fast-forward only), `hourly` is a single commit replaced every run. The
# server holds no key that decrypts a backup, and no plaintext outlives the run.
#
# Installed as /usr/local/sbin/agentmesh-backup by deploy/backup/install.sh. Settings: the
# defaults below, overridden by /etc/default/agentmesh-backup.
set -euo pipefail
umask 077

: "${AGENTMESH_DIR:=/opt/agentmesh}"     # the repo checkout the stack runs from
: "${BACKUP_REMOTE:=}"                   # the private backup repository (SSH URL)
: "${AGE_RECIPIENT:=}"                   # the admin's age public key (age1…)
: "${BACKUP_PATHS:=config deploy/.env deploy/secrets deploy/nats/nats.conf deploy/docker-compose.override.yml}"
: "${BACKUP_SSH_KEY:=$HOME/.ssh/agentmesh-backup}"
if [ -r /etc/default/agentmesh-backup ]; then . /etc/default/agentmesh-backup; fi
STATE_DIR=${STATE_DIRECTORY:-/var/lib/agentmesh-backup}
FILE=hub-backup.tar.gz.age

log() { printf '== %s\n' "$*"; }
fail() { echo "agentmesh-backup: $*" >&2; exit 1; }

# Runs inside the hub container (node is all it has). VACUUM INTO takes a consistent copy while the
# hub keeps serving, WAL included; the copy must pass quick_check before it leaves. Same approach
# as agentmesh-deploy's pre-deploy backup, under its own file name so the two never collide.
read -r -d '' SNAPSHOT_JS <<'JS' || true
const fs = require('node:fs');
const { pipeline } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');
const dir = process.env.AGENTMESH_DATA_DIR || '/data';
const copy = `${dir}/.offsite-backup.sqlite`;
fs.rmSync(copy, { force: true });
const db = new DatabaseSync(`${dir}/hub.sqlite`);
db.exec(`VACUUM INTO '${copy}'`);
db.close();
const check = new DatabaseSync(copy);
const result = Object.values(check.prepare('PRAGMA quick_check').get())[0];
check.close();
if (result !== 'ok') {
  fs.rmSync(copy, { force: true });
  console.error(`snapshot failed quick_check: ${result}`);
  process.exit(1);
}
pipeline(fs.createReadStream(copy), process.stdout, (err) => {
  fs.rmSync(copy, { force: true });
  if (err) { console.error(`snapshot failed: ${err.message}`); process.exitCode = 1; }
});
JS

git_() {
  git -c user.name=agentmesh-backup -c user.email=agentmesh-backup@localhost \
    -c init.defaultBranch=main -c advice.detachedHead=false "$@"
}

# Commits $WORK/$FILE as the only change on top of a fresh clone of `main` (or as its first commit).
push_daily() {
  local day=$1 dir=$WORK/daily
  if git ls-remote --exit-code "$BACKUP_REMOTE" refs/heads/main >/dev/null; then
    git_ clone --quiet --depth 1 --branch main "$BACKUP_REMOTE" "$dir"
  else
    git_ init --quiet "$dir"
  fi
  cp "$WORK/$FILE" "$dir/$FILE"
  git_ -C "$dir" add "$FILE"
  git_ -C "$dir" commit --quiet -m "daily $day"
  git_ -C "$dir" push --quiet "$BACKUP_REMOTE" HEAD:refs/heads/main
}

# Replaces `hourly` with a single new commit; the old copy is gone from the branch.
push_hourly() {
  local dir=$WORK/hourly
  git_ init --quiet "$dir"
  cp "$WORK/$FILE" "$dir/$FILE"
  git_ -C "$dir" add "$FILE"
  git_ -C "$dir" commit --quiet -m "hourly $(date -u +%FT%TZ)"
  git_ -C "$dir" push --quiet --force "$BACKUP_REMOTE" HEAD:refs/heads/hourly
}

run() {
  [ -n "$BACKUP_REMOTE" ] || fail "set BACKUP_REMOTE in /etc/default/agentmesh-backup"
  [[ $AGE_RECIPIENT == age1* ]] || fail "set AGE_RECIPIENT (age1…) in /etc/default/agentmesh-backup"
  [ -f "$AGENTMESH_DIR/deploy/docker-compose.yml" ] || fail "no checkout at $AGENTMESH_DIR; set AGENTMESH_DIR"
  mkdir -p "$STATE_DIR"
  WORK=$(mktemp -d "${RUNTIME_DIRECTORY:-${TMPDIR:-/tmp}}/run.XXXXXX")
  trap 'rm -rf "$WORK"' EXIT
  # The backup repository's host key comes from install.sh (GitHub's published keys), never TOFU.
  export GIT_SSH_COMMAND="ssh -i $BACKUP_SSH_KEY -o IdentitiesOnly=yes -o BatchMode=yes \
-o StrictHostKeyChecking=yes -o UserKnownHostsFile=$BACKUP_SSH_KEY.known_hosts"

  log "snapshot hub.sqlite"
  (cd "$AGENTMESH_DIR/deploy" && docker compose exec -T hub node --no-warnings -e "$SNAPSHOT_JS") \
    >"$WORK/hub.sqlite" || fail "the snapshot failed; nothing was pushed"
  [ -s "$WORK/hub.sqlite" ] || fail "the snapshot is empty; nothing was pushed"

  local path paths=()
  for path in $BACKUP_PATHS; do
    if [ -e "$AGENTMESH_DIR/$path" ]; then paths+=("$path"); else echo "warning: no $path to back up" >&2; fi
  done
  log "bundle and encrypt: hub.sqlite ${paths[*]}"
  tar -czf - -C "$WORK" hub.sqlite -C "$AGENTMESH_DIR" "${paths[@]}" |
    age -r "$AGE_RECIPIENT" >"$WORK/$FILE" || fail "bundling or encrypting failed; nothing was pushed"
  rm -f "$WORK/hub.sqlite"

  # The daily copy first: on an empty repository the first branch pushed becomes the default one,
  # and the watch workflow must live on `main`.
  local day
  day=$(date -u +%F)
  if [ "$(cat "$STATE_DIR/last-daily" 2>/dev/null)" != "$day" ]; then
    log "push the daily copy for $day"
    push_daily "$day"
    echo "$day" >"$STATE_DIR/last-daily"
  fi
  log "push the hourly copy"
  push_hourly
  date -u +%FT%TZ >"$STATE_DIR/last-hourly"
  log "done ($(wc -c <"$WORK/$FILE") bytes encrypted)"
}

status() {
  echo "last hourly copy: $(cat "$STATE_DIR/last-hourly" 2>/dev/null || echo never)"
  echo "last daily copy:  $(cat "$STATE_DIR/last-daily" 2>/dev/null || echo never)"
  echo "remote:           ${BACKUP_REMOTE:-not set}"
}

case ${1-} in
  run) run ;;
  status) status ;;
  *) echo "usage: agentmesh-backup run|status" >&2; exit 2 ;;
esac
