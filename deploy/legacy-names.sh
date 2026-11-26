# Shared by the server installers (deploy/auto-deploy/install.sh, deploy/backup/install.sh):
# sourced, never run, and it only defines functions. Until 0.8.0 Cosmicwave was called AgentMesh,
# and a server set up then has its scripts, settings, units and keys under agentmesh-* names. These
# take such an install over without losing its settings or keys.

# Moves settings written before the rename to the new name, with AGENTMESH_DIR renamed to
# COSMICWAVE_DIR (commented or not), and the backup key's path ~/.ssh/agentmesh-backup, which the
# backup installer moves, renamed to ~/.ssh/cosmicwave-backup. Every other line is kept as it is.
# Settings already under the new name are kept as they are, and the old file is removed only once
# the new one is in place.
carry_settings() {
  if [ ! -e "$1" ] || [ -e "$2" ] || [ -L "$2" ]; then return 0; fi
  sed -e 's/AGENTMESH_DIR/COSMICWAVE_DIR/g' \
    -e "s#/\.ssh/agentmesh-backup\([\"'[:space:]]\|\$\)#/.ssh/cosmicwave-backup\1#g" "$1" >"$2.new" &&
    chmod 644 "$2.new" && mv "$2.new" "$2" && rm -f "$1" &&
    echo "moved $1 to $2"
}

# Moves a file or folder to its new name, unless something already has that name.
carry_path() {
  if [ ! -e "$1" ] || [ -e "$2" ] || [ -L "$2" ]; then return 0; fi
  mv "$1" "$2" && echo "moved $1 to $2"
}

# Prints an authorized_keys file without its deploy-key lines, under either name and with or
# without a Windows line ending, so a server never keeps a second deploy key. Every other line
# comes through byte for byte, in order: -a keeps grep from reading the file as binary (a NUL, or a
# byte that is not UTF-8 in a UTF-8 locale) and silently leaving lines out; -U keeps the CRs (it
# does nothing on Linux; Windows builds of grep strip them). Fails when the file cannot be read
# (grep exits 2), rather than printing nothing.
without_deploy_lines() {
  local rc=0
  grep -a -U -v -E -e $' (cosmicwave|agentmesh)-github-deploy\r?$' -- "$1" || rc=$?
  [ "$rc" -le 1 ]
}
