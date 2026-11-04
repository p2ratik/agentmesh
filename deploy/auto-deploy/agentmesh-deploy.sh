#!/usr/bin/env bash
# AgentMesh: deploys a released version of the hub and the Discord bridge on this server.
# The GitHub Actions deploy workflow runs it over SSH as the deploy key's forced command
# (docs/deploy.md#automatic-deploys), so that key can run nothing else. An admin can run it too:
#
#   agentmesh-deploy deploy 0.5.1   # pull the images, back up hub-data (online), switch, wait for
#                                   # /healthz; a release that is not ready is rolled back
#   agentmesh-deploy status         # the deployed release and the containers
#
# Installed as /usr/local/sbin/agentmesh-deploy by deploy/auto-deploy/install.sh. Settings: the
# defaults below, overridden by /etc/default/agentmesh-deploy. It never reads deploy/.env and
# never prints container logs: its output is the workflow's log, which is public on a public repo.
set -euo pipefail
umask 077

refuse() {
  echo "agentmesh-deploy: refused: expected 'deploy <version>' (such as 0.5.1) or 'status'" >&2
  exit 2
}

# The forced command receives the client's command line in SSH_ORIGINAL_COMMAND. It is matched
# against two fixed shapes and never evaluated, so the key cannot run anything else.
if [ "$#" -gt 0 ]; then REQUEST="$*"; else REQUEST=${SSH_ORIGINAL_COMMAND-}; fi
if [[ $REQUEST =~ ^deploy\ ([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?)$ ]]; then
  ACTION=deploy VERSION=${BASH_REMATCH[1]}
elif [ "$REQUEST" = status ]; then
  ACTION=status
else
  refuse
fi

: "${AGENTMESH_DIR:=/opt/agentmesh}"      # the repo checkout the stack runs from
: "${IMAGE_REGISTRY:=ghcr.io/p2ratik}"    # where the release workflow publishes the images
: "${COMPOSE_PROFILES=discord}"           # empty when the mesh runs without the Discord bridge
: "${GIT_REMOTE:=origin}"
: "${RELEASE_BRANCH:=main}"               # a release tag must be on this branch
: "${BACKUP_DIR:=$HOME/backups}"
: "${KEEP_BACKUPS:=10}"                   # backups this script made that it keeps
: "${HEALTH_TIMEOUT:=60}"                 # seconds for the new hub's /healthz to answer 200
: "${STATE_DIR:=$HOME/.local/state/agentmesh-deploy}"
if [ -r /etc/default/agentmesh-deploy ]; then . /etc/default/agentmesh-deploy; fi
export COMPOSE_PROFILES

DEPLOY_DIR=$AGENTMESH_DIR/deploy
# Compose merges docker-compose.override.yml on its own, so hand-run commands use the same images.
OVERRIDE=$DEPLOY_DIR/docker-compose.override.yml
[ -f "$DEPLOY_DIR/docker-compose.yml" ] ||
  { echo "agentmesh-deploy: no $DEPLOY_DIR/docker-compose.yml; set AGENTMESH_DIR" >&2; exit 1; }
SERVICES=(hub)
if [[ ,$COMPOSE_PROFILES, == *,discord,* ]]; then SERVICES+=(discord-bridge); fi
cd "$DEPLOY_DIR"

# One deploy at a time. A dropped SSH connection or a cancelled workflow must not stop a deploy
# halfway: SIGHUP is ignored, and the output is kept in deploy.log after the connection is gone.
begin_deploy() {
  mkdir -p "$STATE_DIR"
  exec 9>"$STATE_DIR/lock"
  flock -n 9 || { echo "agentmesh-deploy: another deploy is running" >&2; exit 75; }
  trap '' HUP
  exec > >(tee -a -p "$STATE_DIR/deploy.log") 2>&1
  TEE_PID=$!
  # Bash does not wait for a process substitution: flush tee before exiting (keeps the status).
  trap 'exec >&- 2>&-; wait "$TEE_PID"' EXIT
}

log() { printf '== %s\n' "$*"; }
git_() { git -C "$AGENTMESH_DIR" "$@"; }
image() { printf '%s/agentmesh-%s:%s' "$IMAGE_REGISTRY" "$1" "$2"; }
deployed() { git_ describe --tags --always HEAD 2>/dev/null || echo unknown; }

write_override() {
  {
    echo "# Written by agentmesh-deploy: the stack runs the published images of the last deploy."
    echo "# Change the version with: agentmesh-deploy deploy <version>"
    echo "services:"
    for svc in "${SERVICES[@]}"; do printf '  %s:\n    image: %s\n' "$svc" "$(image "$svc" "$1")"; done
  } >"$OVERRIDE.tmp" && mv "$OVERRIDE.tmp" "$OVERRIDE"
}

# Run inside the hub container (node is all it has). The backup copies hub.sqlite with SQLite's
# VACUUM INTO, a consistent snapshot taken while the hub keeps serving, and streams it gzipped.
read -r -d '' ONLINE_BACKUP_JS <<'JS' || true
const fs = require('node:fs');
const { pipeline } = require('node:stream');
const { createGzip } = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const dir = process.env.AGENTMESH_DATA_DIR || '/data';
const copy = `${dir}/.deploy-backup.sqlite`;
fs.rmSync(copy, { force: true });
const db = new DatabaseSync(`${dir}/hub.sqlite`);
db.exec(`VACUUM INTO '${copy}'`);
db.close();
pipeline(fs.createReadStream(copy), createGzip(), process.stdout, (err) => {
  fs.rmSync(copy, { force: true });
  if (err) { console.error(`backup failed: ${err.message}`); process.exitCode = 1; }
});
JS
# The hub's readiness (database, NATS round trip, subscriptions): exit 0 only on 200.
HEALTHZ_JS='fetch("http://127.0.0.1:8787/healthz").then(async (r) => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); }).catch(() => process.exit(2))'

# Backs up hub-data into BACKUP_DIR without stopping the hub, so it is down only for the swap.
# A hub that is not running (crashed) is copied as files with the new image's tar instead.
# Only the backups this script made are pruned.
backup() {
  local hub volume stamp file
  hub=$(docker compose ps -a -q hub) || return 1
  [ -n "$hub" ] || { log "no hub container yet: nothing to back up"; return 0; }
  mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR" || return 1
  stamp="$BACKUP_DIR/hub-data-$(date -u +%Y%m%d-%H%M%S)-pre-$VERSION.auto"
  if [ "$(docker inspect -f '{{.State.Running}}' "$hub")" = true ]; then
    file=$stamp.sqlite.gz
    docker compose exec -T hub node --no-warnings -e "$ONLINE_BACKUP_JS" >"$file.part" ||
      { rm -f "$file.part"; return 1; }
  else
    file=$stamp.tgz
    volume=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$hub") || return 1
    docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
      -v "$volume:/data:ro" --entrypoint tar "$(image hub "$VERSION")" -czf - -C /data . \
      >"$file.part" || { rm -f "$file.part"; return 1; }
  fi
  mv "$file.part" "$file"
  log "backup: $file"
  ls -1t "$BACKUP_DIR"/hub-data-*.auto.* | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f -- ||
    echo "warning: could not prune old backups in $BACKUP_DIR"
}

# "<status> <restart count>" of a service's container, or "missing".
state_of() {
  docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$(docker compose ps -q "$1")" 2>/dev/null ||
    echo missing
}
services_state() { local svc; for svc in nats "${SERVICES[@]}"; do echo "$svc $(state_of "$svc")"; done; }

# Ready: the hub's /healthz answers 200, asked every 2 s from inside the container. A hub that
# stops or restarts fails at once (counted from the first look: a redeploy of the same version
# keeps its container and its old count). Then every service must keep running for 10 s.
wait_ready() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) first state report= before after
  first=$(state_of hub)
  while :; do
    state=$(state_of hub)
    [[ $state == "$first" && $state == 'running '* ]] ||
      { echo "the hub is not running steadily ($state)"; return 1; }
    report=$(docker compose exec -T hub node -e "$HEALTHZ_JS" 2>/dev/null) && break
    ((SECONDS < deadline)) || { echo "the hub is not ready after ${HEALTH_TIMEOUT}s: ${report:-no answer}"; return 1; }
    sleep 2
  done
  log "the hub is ready: $report"
  before=$(services_state)
  sleep 10
  after=$(services_state)
  if [ "$before" != "$after" ] || grep -qv '^[^ ]* running ' <<<"$after"; then
    printf 'not every service keeps running:\n%s\n' "$after"
    return 1
  fi
}

# Every step checks its own result: set -e does not apply inside a function called from `if`.
switch_to() {
  log "checkout v$VERSION"
  git_ -c advice.detachedHead=false checkout --quiet --detach "v$VERSION" || return 1
  write_override "$VERSION" || return 1
  log "back up hub-data"
  backup || return 1
  log "start $VERSION"
  docker compose up -d --no-build --pull never || return 1
  log "wait for the hub to be ready"
  wait_ready
}

rollback() {
  log "rolling back to $PREV_DEPLOYED"
  if [ -f "$OVERRIDE.prev" ]; then mv "$OVERRIDE.prev" "$OVERRIDE"; else rm -f "$OVERRIDE"; fi
  git_ -c advice.detachedHead=false checkout --quiet --detach "$PREV_REF" &&
    docker compose up -d --no-build --pull never && wait_ready &&
    { log "rolled back to $PREV_DEPLOYED; v$VERSION is not running"; return 0; }
  echo "agentmesh-deploy: the rollback is not ready either. On the server: cd $DEPLOY_DIR" \
    "&& docker compose ps && docker compose logs --tail 50 hub" >&2
}

deploy() {
  begin_deploy
  log "deploy $VERSION (now: $(deployed))"
  # A release is a tag the release workflow pushed on the release branch: refuse any other tag,
  # and never move a tag this checkout already has.
  git_ fetch --quiet --no-tags "$GIT_REMOTE" \
    "+refs/heads/$RELEASE_BRANCH:refs/remotes/$GIT_REMOTE/$RELEASE_BRANCH" \
    "refs/tags/v$VERSION:refs/tags/v$VERSION" ||
    { echo "agentmesh-deploy: cannot fetch tag v$VERSION from $GIT_REMOTE" >&2; exit 1; }
  git_ merge-base --is-ancestor "v$VERSION^{commit}" "$GIT_REMOTE/$RELEASE_BRANCH" ||
    { echo "agentmesh-deploy: v$VERSION is not on $RELEASE_BRANCH; refusing" >&2; exit 1; }

  log "pull the $VERSION images"
  for svc in "${SERVICES[@]}"; do
    docker pull -q "$(image "$svc" "$VERSION")" ||
      { echo "agentmesh-deploy: cannot pull $(image "$svc" "$VERSION"); nothing changed" >&2; exit 1; }
  done

  PREV_REF=$(git_ rev-parse HEAD)
  PREV_DEPLOYED=$(deployed)
  if [ -f "$OVERRIDE" ]; then cp -p "$OVERRIDE" "$OVERRIDE.prev"; else rm -f "$OVERRIDE.prev"; fi
  if ! switch_to; then
    rollback
    echo "agentmesh-deploy: deploying $VERSION failed. A backup taken before it is in $BACKUP_DIR." >&2
    exit 1
  fi
  rm -f "$OVERRIDE.prev"
  log "deployed $VERSION (was $PREV_DEPLOYED)"
  docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
}

status() {
  echo "deployed: $(deployed)"
  docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
}

"$ACTION"
