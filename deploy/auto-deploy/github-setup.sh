# Shared by the cloud setup scripts (deploy/{azure,aws}/github-deploy-setup.sh): sourced, never run.
# The caller sets REPO, ENVIRONMENT, DEPLOY_HOST, DEPLOY_USER, TARGET, TMP and SSH_CMD and runs it
# from the repo root.

# Installs agentmesh-deploy and a new deploy key on the server (a re-run rotates the key), then
# creates the `production` environment with that key and the variables every deploy reads. The
# private key goes from $TMP into the GitHub secret; the caller's trap deletes it.
setup_server_and_github() {
  local remote host_key
  echo "== server: deploy endpoint and key"
  ssh-keygen -q -t ed25519 -N '' -C agentmesh-github-deploy -f "$TMP/deploy_key"
  printf -v remote 'd=$(mktemp -d) && tar -xf - -C "$d" && sudo MESH_USER=%q DEPLOY_PUBKEY=%q bash "$d/install.sh"; rc=$?; rm -rf "$d"; exit $rc' \
    "$DEPLOY_USER" "$(cat "$TMP/deploy_key.pub")"
  tar -cf - -C deploy/auto-deploy agentmesh-deploy.sh install.sh | "${SSH_CMD[@]}" "$TARGET" "$remote"
  # Read over the SSH session just authenticated, so the host key is the one this laptop trusts.
  host_key=$("${SSH_CMD[@]}" "$TARGET" cat /etc/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f1,2)

  echo "== GitHub: environment $ENVIRONMENT, deploy key and variables"
  echo '{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}' |
    gh api -X PUT "repos/$REPO/environments/$ENVIRONMENT" --input - >/dev/null
  if ! gh api "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
    --jq '.branch_policies[].name' | grep -qx main; then
    gh api -X POST "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
      -f name=main -f type=branch >/dev/null
  fi
  gh secret set DEPLOY_SSH_KEY --repo "$REPO" --env "$ENVIRONMENT" <"$TMP/deploy_key"
  gh variable set DEPLOY_HOST --repo "$REPO" --body "$DEPLOY_HOST"
  gh variable set DEPLOY_USER --repo "$REPO" --body "$DEPLOY_USER"
  gh variable set DEPLOY_KNOWN_HOSTS --repo "$REPO" --body "$DEPLOY_HOST $host_key"
}

# The subject of the OIDC tokens GitHub issues to this repo's environment: the repo's prefix as
# GitHub reports it (with immutable subjects repo:<owner>@<owner id>/<repo>@<repo id>; older repos
# use repo:<owner>/<repo>), then :environment:<name>.
oidc_subject() {
  local prefix
  prefix=$(gh api "repos/$REPO/actions/oidc/customization/sub" --jq '.sub_claim_prefix // empty' 2>/dev/null) ||
    prefix=
  printf '%s:environment:%s' "${prefix:-repo:$REPO}" "$ENVIRONMENT"
}
