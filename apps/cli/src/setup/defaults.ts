/** Where CI publishes the hub and Discord bridge images (`<registry>/agentmesh-hub:<version>`). */
export const DEFAULT_IMAGE_REGISTRY = 'ghcr.io/p2ratik';
/** `host[:port]/namespace…` in lowercase. It goes into .env, so a newline must never pass. */
export const IMAGE_REGISTRY =
  /^[a-z0-9]+([.-][a-z0-9]+)*(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/;
/** A Docker image tag, which is what the version becomes in the image name. */
export const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
/** The plugin marketplace teammates install from (`/plugin marketplace add <this>`). */
export const DEFAULT_MARKETPLACE = 'p2ratik/agentmesh';
/** Where the workspace's `config/` and `deploy/` live on the server. */
export const DEFAULT_REMOTE_DIR = '/opt/agentmesh';
/** Claude Code keeps 4096 characters of MCP instructions; the team policy shares them. */
export const MAX_POLICY_CHARS = 2000;
export const NATS_PORT = 4222;
