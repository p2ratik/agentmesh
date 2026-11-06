export { isAtLeast } from '@agentmesh/common/version';

/**
 * Older plugins cannot take per-session delivery (before 0.2.0) or report the
 * FYIs they showed (`messages.seen`, before 0.3.0); there is no compatibility mode.
 */
export const MIN_CLIENT_VERSION = '0.3.0';
