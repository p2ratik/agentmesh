// Plain constants, no zod: the guard and hook bundles import this file and stay built-ins only.

/** Why a guard, relay or activation check said no. Every "why" in an event is one of these. */
export const REASON_CODES = [
  'send.unknown_key',
  'send.bad_address',
  'send.alias_mismatch',
  'send.content_mismatch',
  'send.bad_summary',
  'send.no_record',
  'send.claim_failed',
  'list_agents',
  'path.outside_worktree',
  'path.no_file',
  'path.not_absolute',
  'path.device',
  'path.unresolved',
  'path.link',
  'path.not_registered_worktree',
  'path.git_dir',
  'path.agentmesh_dir',
  'command.not_listed',
  'command.needs_approval',
  'command.risky',
  'secret.path',
  'secret.credential',
  'secret.env_dump',
  'tool.unknown',
  'tool.enter_worktree',
  'tool.agent_isolated',
  'tool.workflow',
  'marker.unverified',
  'guard.unreadable',
  'guard.error',
  'activation.wrong_code',
  'activation.guard_down',
  'activation.not_window',
  'activation.another_window_live',
  'activation.no_proof',
  'activation.hub_error',
  'activation.no_description',
  'activation.pull_in_window',
  'auth.no_signature',
  'auth.bad_signature',
  'auth.unknown_key',
  'auth.too_many_from_address',
  'auth.malformed_invite',
  'auth.too_many_redemptions',
  'auth.invite_refused',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const EVENT_SOURCES = ['plugin', 'guard', 'hook'] as const;
export const REPORTED_KINDS = [
  'connected',
  'nats',
  'activation',
  'tool',
  'delivery',
  'relay',
  'guard',
  'hook',
  'dropped',
] as const;
export const HUB_KINDS = ['session', 'delivery', 'relay', 'orphan', 'rpc', 'auth'] as const;

export const NATS_EVENTS = ['disconnect', 'reconnect', 'error'] as const;
export const ACTIVATION_PHASES = [
  'check_sent',
  'activated',
  'refused',
  'failed',
  'renewed',
  'renewal_fallback',
  'deactivated',
] as const;
export const DELIVERY_MODES = ['push', 'pull'] as const;
export const PLUGIN_DELIVERY_STAGES = [
  'received',
  'pushed',
  'push_failed',
  'deduped',
  'held',
] as const;
export const PLUGIN_RELAY_STAGES = ['pushed', 'claimed', 'expired', 'denied'] as const;
export const GUARD_DECISIONS = ['deny', 'ask'] as const;
export const HOOK_NOTES = [
  'note_shown',
  'pull_shown',
  'pointer_labelled',
  'window_labelled',
  'not_mesh_labelled',
  'error',
] as const;
export const HUB_SESSION_PHASES = [
  'opened',
  'hello',
  'away',
  'live',
  'closed',
  'evicted',
  'taken_over',
] as const;
export const HUB_DELIVERY_STAGES = ['sent', 'acked', 'failed', 'no_session'] as const;
export const HUB_RELAY_STAGES = ['sent', 'forwarded', 'not_forwarded'] as const;
export const ORPHAN_PHASES = ['recorded', 'escalated', 'settled'] as const;
export const AUTH_EVENTS = ['denied', 'budget_hit'] as const;
/** Node's `process.platform` values (@types/node's list; observe.test.ts pins it). */
export const NODE_PLATFORMS = [
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd',
] as const;
/** Node's `process.arch` values (@types/node's list; observe.test.ts pins it). */
export const NODE_ARCHES = [
  'arm',
  'arm64',
  'ia32',
  'loong64',
  'mips',
  'mipsel',
  'ppc64',
  'riscv64',
  's390x',
  'x64',
] as const;
