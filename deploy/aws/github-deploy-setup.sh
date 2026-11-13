#!/usr/bin/env bash
# One-time setup of automatic deploys from GitHub Actions to a hub on AWS EC2
# (docs/deploy.md#setting-it-up-on-aws). Run it from the repo root on the admin's laptop, signed in
# to `aws` (allowed to manage IAM roles and OIDC providers and the instance's security groups; pick
# the account with AWS_PROFILE) and to `gh` (admin of the repository), with key-based SSH to the
# server:
#
#   AWS_PROFILE=<profile> AWS_REGION=<region> REPO=acme/agentmesh INSTANCE=i-0123456789abcdef0 \
#   DEPLOY_USER=ubuntu DEPLOY_HOST=mesh.example.com ./deploy/aws/github-deploy-setup.sh
#
# It sets up:
#   AWS     GitHub's OIDC provider; a security group of its own on the instance, empty between
#           deploys; and a role that only this repo's `production` environment can assume, allowed
#           only to add and remove inbound rules in that group. No access key exists.
#   Server  /usr/local/sbin/agentmesh-deploy and a deploy key that can run nothing else
#           (deploy/auto-deploy/install.sh).
#   GitHub  the `production` environment (deploys from main only), its secrets, and the
#           repository variables the workflows read. It removes the Azure ones, if any.
# The deploy key's private half goes from a temporary folder into the GitHub secret, then is
# deleted; nothing secret is printed. Safe to re-run: it reuses what exists and rotates the key.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash: never rewrite arguments that look like paths
# Git Bash: aws on Windows ends its text output with \r\n and $(…) keeps the \r, so every id stored
# below would carry an invisible \r. Strip it.
aws() { command aws "$@" | tr -d '\r'; }

: "${REPO:?set REPO to owner/name of the GitHub repository}"
: "${INSTANCE:?set INSTANCE to the EC2 instance id of the hub server}"
# Never the profile's default region: a laptop's default often differs from the hub's, and an
# organization may allow EC2 in one region only.
: "${AWS_REGION:?set AWS_REGION to the region of the instance, such as ap-southeast-2}"
: "${DEPLOY_HOST:?set DEPLOY_HOST to the DNS name of the server}"
: "${DEPLOY_USER:=ubuntu}"
: "${ENVIRONMENT:=production}"
: "${ROLE_NAME:=agentmesh-github-deploy}"
: "${SG_NAME:=agentmesh-github-deploy}"
# -4: a DNS64 resolver can hand out a NAT64 address that does not route.
read -r -a SSH_CMD <<<"${SSH:-ssh} -4 -o BatchMode=yes"
TARGET="$DEPLOY_USER@$DEPLOY_HOST"

for tool in aws gh ssh ssh-keygen tar; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done
REGION=$AWS_REGION
export AWS_REGION
ACCOUNT=$(aws sts get-caller-identity --query Account --output text) ||
  { echo "sign in first (aws sso login, or set AWS_PROFILE)" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "sign in first: gh auth login" >&2; exit 1; }
"${SSH_CMD[@]}" "$TARGET" true || { echo "ssh $TARGET does not work without a prompt" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
. deploy/auto-deploy/github-setup.sh

# Before creating anything: the instance must be in this account, so a wrong profile stops here.
echo "== AWS: account $ACCOUNT, $REGION, instance $INSTANCE"
INFO=$(aws ec2 describe-instances --instance-ids "$INSTANCE" --output text \
  --query 'Reservations[0].Instances[0].[VpcId, join(`,`, SecurityGroups[].GroupId)]') ||
  { echo "cannot read instance $INSTANCE in account $ACCOUNT ($REGION): check AWS_PROFILE and AWS_REGION." \
      "An 'explicit deny in a service control policy' above means your organization does not allow EC2 there." >&2; exit 1; }
read -r VPC INSTANCE_SGS <<<"$INFO"

# GitHub's token issuer. IAM fetches its certificate thumbprint itself. An organization can forbid
# OIDC providers (an SCP); then stop here, before anything is created.
PROVIDER=arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com
if OUT=$(aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER" \
  --query "contains(ClientIDList, 'sts.amazonaws.com')" --output text 2>&1); then
  [ "$OUT" = True ] || aws iam add-client-id-to-open-id-connect-provider \
    --open-id-connect-provider-arn "$PROVIDER" --client-id sts.amazonaws.com
elif [[ $OUT == *NoSuchEntity* ]]; then
  aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com >/dev/null
else
  echo "$OUT" >&2
  echo "This account may not use GitHub's OIDC provider, which the deploy signs in with. If the error" \
    "names a service control policy, exempt that provider in it (docs/deploy.md#setting-it-up-on-aws)." >&2
  exit 1
fi

# A group of its own, so the role can touch no other rule: not the admin's SSH, not NATS.
DEPLOY_SG=$(aws ec2 describe-security-groups --output text --query 'SecurityGroups[0].GroupId' \
  --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC")
if [ -z "$DEPLOY_SG" ] || [ "$DEPLOY_SG" = None ]; then
  DEPLOY_SG=$(aws ec2 create-security-group --group-name "$SG_NAME" --vpc-id "$VPC" \
    --description "AgentMesh GitHub deploy: SSH from the runner, only while a deploy runs" \
    --query GroupId --output text)
fi
case ",$INSTANCE_SGS," in
  *",$DEPLOY_SG,"*) ;;
  # The list replaces the instance's groups, so it names the ones it has as well.
  *) aws ec2 modify-instance-attribute --instance-id "$INSTANCE" --groups ${INSTANCE_SGS//,/ } "$DEPLOY_SG" ;;
esac

# JSON for aws stays on one line: a native Windows program may not get newlines in an argument.
json() { printf "$@" | tr -d '\n'; }
SUBJECT=$(oidc_subject)
TRUST=$(json '{"Version": "2012-10-17", "Statement": [{"Effect": "Allow",
  "Principal": {"Federated": "%s"}, "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {"StringEquals": {"token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                                 "token.actions.githubusercontent.com:sub": "%s"}}}]}' "$PROVIDER" "$SUBJECT")
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  # A re-run fixes a subject an earlier run got wrong.
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST"
else
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST" \
    --description "AgentMesh GitHub deploys of $REPO: opens SSH to the runner for one run" >/dev/null
fi
# Add and remove inbound rules in the deploy group: nothing else, on nothing else. IAM cannot limit
# the port or the address of a rule, hence the group of its own. Describe calls take no resource.
POLICY=$(json '{"Version": "2012-10-17", "Statement": [
  {"Effect": "Allow", "Action": ["ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress"],
   "Resource": ["arn:aws:ec2:%s:%s:security-group/%s", "arn:aws:ec2:%s:%s:security-group-rule/*"]},
  {"Effect": "Allow", "Action": "ec2:DescribeSecurityGroupRules", "Resource": "*"}]}' \
  "$REGION" "$ACCOUNT" "$DEPLOY_SG" "$REGION" "$ACCOUNT")
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name deploy-ssh-rule --policy-document "$POLICY"
echo "AWS trusts tokens with the subject $SUBJECT for the role $ROLE_NAME; deploy group $DEPLOY_SG"

setup_server_and_github
echo "== GitHub: AWS secret and variables"
# Not secret, but stored as a secret so the account id is masked in the public workflow log.
gh secret set AWS_DEPLOY_ROLE_ARN --repo "$REPO" --env "$ENVIRONMENT" \
  --body "arn:aws:iam::$ACCOUNT:role/$ROLE_NAME"
gh variable set AWS_REGION --repo "$REPO" --body "$REGION"
gh variable set AWS_DEPLOY_SG --repo "$REPO" --body "$DEPLOY_SG"
# A deploy that still found the Azure settings would try to sign in to Azure too.
for name in AZURE_NSG AZURE_RESOURCE_GROUP; do
  if gh variable delete "$name" --repo "$REPO" >/dev/null 2>&1; then echo "removed the variable $name"; fi
done
for name in AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_SUBSCRIPTION_ID; do
  if gh secret delete "$name" --repo "$REPO" --env "$ENVIRONMENT" >/dev/null 2>&1; then
    echo "removed the secret $name"
  fi
done

echo "== done. Every release on main now deploys itself. To deploy or roll back by hand:"
echo "   gh workflow run deploy.yml --repo $REPO -f version=<x.y.z> && gh run watch --repo $REPO"
