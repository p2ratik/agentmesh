#!/usr/bin/env bash
# Creates the AgentMesh hub VM on Azure with the Azure CLI (run where `az login` works).
#
#   DNS_LABEL=acme-agentmesh ./deploy/azure/provision.sh
#
# Result: an Ubuntu 24.04 VM reachable at <DNS_LABEL>.<LOCATION>.cloudapp.azure.com with a
# firewall that allows SSH from your current IP only, NATS (TLS) on 4222 and HTTP on 80
# (Let's Encrypt renewals). Every value below can be overridden with an env var.
set -euo pipefail

: "${DNS_LABEL:?set DNS_LABEL — the VM becomes <label>.<location>.cloudapp.azure.com}"
: "${LOCATION:=centralindia}"
: "${RESOURCE_GROUP:=rg-agentmesh}"
: "${VM_NAME:=vm-agentmesh}"
: "${VM_SIZE:=Standard_B2als_v2}"
: "${ADMIN_USER:=mesh}"
: "${SSH_PUBLIC_KEY:=$HOME/.ssh/id_ed25519.pub}"
: "${OS_DISK_GB:=30}"
: "${ADMIN_CIDR:=$(curl -fsS https://api.ipify.org)/32}"

NSG="nsg-$VM_NAME"
PIP="pip-$VM_NAME"

echo "Resource group $RESOURCE_GROUP in $LOCATION"
az group create -n "$RESOURCE_GROUP" -l "$LOCATION" -o none

echo "Firewall $NSG (SSH from $ADMIN_CIDR only)"
az network nsg create -g "$RESOURCE_GROUP" -n "$NSG" -l "$LOCATION" -o none
allow() {
  az network nsg rule create -g "$RESOURCE_GROUP" --nsg-name "$NSG" -n "$1" --priority "$2" \
    --direction Inbound --access Allow --protocol Tcp \
    --destination-port-ranges "$3" --source-address-prefixes "$4" -o none
}
allow allow-ssh-admin 100 22 "$ADMIN_CIDR"
allow allow-nats-tls 110 4222 Internet
allow allow-acme-http 120 80 Internet

echo "Static public IP $PIP with DNS label $DNS_LABEL"
az network public-ip create -g "$RESOURCE_GROUP" -n "$PIP" -l "$LOCATION" \
  --sku Standard --allocation-method Static --dns-name "$DNS_LABEL" -o none

echo "VM $VM_NAME ($VM_SIZE)"
az vm create -g "$RESOURCE_GROUP" -n "$VM_NAME" -l "$LOCATION" \
  --image Canonical:ubuntu-24_04-lts:server:latest --size "$VM_SIZE" \
  --admin-username "$ADMIN_USER" --ssh-key-values "$SSH_PUBLIC_KEY" \
  --public-ip-address "$PIP" --nsg "$NSG" \
  --os-disk-size-gb "$OS_DISK_GB" --storage-sku StandardSSD_LRS -o none

FQDN=$(az network public-ip show -g "$RESOURCE_GROUP" -n "$PIP" --query dnsSettings.fqdn -o tsv)
echo
echo "Ready: ssh $ADMIN_USER@$FQDN"
echo "Next:  clone the repo to /opt/agentmesh on the VM, then"
echo "       sudo PUBLIC_HOST=$FQDN /opt/agentmesh/deploy/azure/vm-setup.sh"
