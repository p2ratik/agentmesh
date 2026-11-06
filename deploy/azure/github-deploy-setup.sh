#!/usr/bin/env bash
# One-time setup of automatic deploys from GitHub Actions to an Azure hub VM
# (docs/deploy.md#automatic-deploys). Run it from the repo root on the admin's laptop, signed in
# to `az` (allowed to create app registrations, custom roles and role assignments on the resource
# group) and to `gh` (admin of the repository), with key-based SSH to the VM:
#
#   REPO=acme/agentmesh RG=rg-agentmesh NSG=nsg-vm-agentmesh DEPLOY_USER=mesh \
#   DEPLOY_HOST=acme-agentmesh.centralindia.cloudapp.azure.com ./deploy/azure/github-deploy-setup.sh
#
# It sets up:
#   Azure   an app registration that only this repo's `production` environment can sign in as
#           (OIDC federation, no client secret), allowed only to add and remove rules on the NSG.
#   Server  /usr/local/sbin/agentmesh-deploy and a deploy key that can run nothing else
#           (deploy/auto-deploy/install.sh).
#   GitHub  the `production` environment (deploys from main only), its secrets, and the
#           repository variables the workflows read.
# The deploy key's private half goes from a temporary folder into the GitHub secret, then is
# deleted; nothing secret is printed. Safe to re-run: it reuses what exists and rotates the key.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash: never rewrite /subscriptions/… arguments into Windows paths
# Git Bash: az on Windows ends its output lines with \r\n and $(…) keeps the \r, so every id stored
# below would carry an invisible \r (secrets with it break the deploy's Azure sign-in). Strip it.
az() { command az "$@" | tr -d '\r'; }

: "${REPO:?set REPO to owner/name of the GitHub repository}"
: "${RG:?set RG to the resource group of the VM}"
: "${NSG:?set NSG to the network security group of the VM}"
: "${DEPLOY_HOST:?set DEPLOY_HOST to the DNS name of the VM}"
: "${DEPLOY_USER:=mesh}"
: "${ENVIRONMENT:=production}"
: "${APP_NAME:=agentmesh-deploy-${REPO//\//-}}"
: "${ROLE_NAME:=AgentMesh deploy NSG rules ($RG)}"
# -4: a DNS64 resolver can hand out a NAT64 address that does not route.
read -r -a SSH_CMD <<<"${SSH:-ssh} -4 -o BatchMode=yes"
TARGET="$DEPLOY_USER@$DEPLOY_HOST"

for tool in az gh ssh ssh-keygen tar; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done
az account show --output none || { echo "sign in first: az login" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "sign in first: gh auth login" >&2; exit 1; }
"${SSH_CMD[@]}" "$TARGET" true || { echo "ssh $TARGET does not work without a prompt" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# A file argument for az. On Windows az is a native program that cannot open Git Bash's /tmp/…
# paths, so it gets the Windows form (cygpath -m: C:/Users/…).
azfile() { if command -v cygpath >/dev/null; then printf '@%s' "$(cygpath -m "$1")"; else printf '@%s' "$1"; fi; }

echo "== Azure: identity for $REPO ($ENVIRONMENT)"
SUBSCRIPTION=$(az account show --query id -o tsv)
TENANT=$(az account show --query tenantId -o tsv)
NSG_ID=$(az network nsg show -g "$RG" -n "$NSG" --query id -o tsv)
APP_ID=$(az ad app list --display-name "$APP_NAME" --query '[0].appId' -o tsv)
[ -n "$APP_ID" ] || APP_ID=$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)
SP_ID=$(az ad sp list --filter "appId eq '$APP_ID'" --query '[0].id' -o tsv)
[ -n "$SP_ID" ] || SP_ID=$(az ad sp create --id "$APP_ID" --query id -o tsv)

# Tokens GitHub issues for jobs in this repo's environment are the only way to sign in. Their
# subject starts with the repo's prefix as GitHub reports it: with immutable subjects that is
# repo:<owner>@<owner id>/<repo>@<repo id>, older repos use repo:<owner>/<repo>.
PREFIX=$(gh api "repos/$REPO/actions/oidc/customization/sub" --jq '.sub_claim_prefix // empty' 2>/dev/null) || PREFIX=
SUBJECT="${PREFIX:-repo:$REPO}:environment:$ENVIRONMENT"
cat >"$TMP/federation.json" <<EOF
{"name": "github-$ENVIRONMENT", "issuer": "https://token.actions.githubusercontent.com",
 "subject": "$SUBJECT", "audiences": ["api://AzureADTokenExchange"],
 "description": "GitHub Actions deploys of $REPO"}
EOF
if [ "$(az ad app federated-credential list --id "$APP_ID" --query "length([?name=='github-$ENVIRONMENT'])" -o tsv)" = 0 ]; then
  az ad app federated-credential create --id "$APP_ID" --parameters "$(azfile "$TMP/federation.json")" --output none
else
  # A re-run fixes a subject an earlier version of this script got wrong.
  az ad app federated-credential update --id "$APP_ID" --federated-credential-id "github-$ENVIRONMENT" \
    --parameters "$(azfile "$TMP/federation.json")" --output none
fi
echo "Azure trusts tokens with the subject $SUBJECT"

# Add, change and remove rules on the NSG: nothing else, on nothing else.
if [ "$(az role definition list --custom-role-only true --name "$ROLE_NAME" --query 'length(@)' -o tsv)" = 0 ]; then
  cat >"$TMP/role.json" <<EOF
{"Name": "$ROLE_NAME", "IsCustom": true,
 "Description": "Lets the AgentMesh GitHub deploy open SSH to its runner for one run.",
 "Actions": ["Microsoft.Network/networkSecurityGroups/read",
             "Microsoft.Network/networkSecurityGroups/securityRules/read",
             "Microsoft.Network/networkSecurityGroups/securityRules/write",
             "Microsoft.Network/networkSecurityGroups/securityRules/delete"],
 "NotActions": [], "AssignableScopes": ["/subscriptions/$SUBSCRIPTION/resourceGroups/$RG"]}
EOF
  az role definition create --role-definition "$(azfile "$TMP/role.json")" --output none
fi
if [ "$(az role assignment list --assignee "$SP_ID" --scope "$NSG_ID" --query 'length(@)' -o tsv)" = 0 ]; then
  # A new role definition can take a minute to become assignable.
  for i in 1 2 3 4 5 6; do
    az role assignment create --assignee-object-id "$SP_ID" --assignee-principal-type ServicePrincipal \
      --role "$ROLE_NAME" --scope "$NSG_ID" --output none && break
    [ "$i" = 6 ] && exit 1
    echo "waiting for the role to become assignable…"; sleep 20
  done
fi

echo "== server: deploy endpoint and key"
ssh-keygen -q -t ed25519 -N '' -C agentmesh-github-deploy -f "$TMP/deploy_key"
printf -v REMOTE 'd=$(mktemp -d) && tar -xf - -C "$d" && sudo MESH_USER=%q DEPLOY_PUBKEY=%q bash "$d/install.sh"; rc=$?; rm -rf "$d"; exit $rc' \
  "$DEPLOY_USER" "$(cat "$TMP/deploy_key.pub")"
tar -cf - -C deploy/auto-deploy agentmesh-deploy.sh install.sh | "${SSH_CMD[@]}" "$TARGET" "$REMOTE"
# Read over the SSH session just authenticated, so the host key is the one this laptop trusts.
HOST_KEY=$("${SSH_CMD[@]}" "$TARGET" cat /etc/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f1,2)

echo "== GitHub: environment $ENVIRONMENT, secrets and variables"
echo '{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}' |
  gh api -X PUT "repos/$REPO/environments/$ENVIRONMENT" --input - >/dev/null
if ! gh api "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
  --jq '.branch_policies[].name' | grep -qx main; then
  gh api -X POST "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
    -f name=main -f type=branch >/dev/null
fi
gh secret set DEPLOY_SSH_KEY --repo "$REPO" --env "$ENVIRONMENT" <"$TMP/deploy_key"
# Not secrets, but stored as secrets so they are masked in the public workflow log.
gh secret set AZURE_CLIENT_ID --repo "$REPO" --env "$ENVIRONMENT" --body "$APP_ID"
gh secret set AZURE_TENANT_ID --repo "$REPO" --env "$ENVIRONMENT" --body "$TENANT"
gh secret set AZURE_SUBSCRIPTION_ID --repo "$REPO" --env "$ENVIRONMENT" --body "$SUBSCRIPTION"
gh variable set DEPLOY_HOST --repo "$REPO" --body "$DEPLOY_HOST"
gh variable set DEPLOY_USER --repo "$REPO" --body "$DEPLOY_USER"
gh variable set DEPLOY_KNOWN_HOSTS --repo "$REPO" --body "$DEPLOY_HOST $HOST_KEY"
gh variable set AZURE_RESOURCE_GROUP --repo "$REPO" --body "$RG"
gh variable set AZURE_NSG --repo "$REPO" --body "$NSG"

echo "== done. Every release on main now deploys itself. To deploy or roll back by hand:"
echo "   gh workflow run deploy.yml --repo $REPO -f version=<x.y.z> && gh run watch --repo $REPO"
