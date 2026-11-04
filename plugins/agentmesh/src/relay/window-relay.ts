import { isAtLeast, RELAY_MIN_VERSION } from '@agentmesh/common/version';
import type { RelayAnswer, SessionRelay } from '@agentmesh/protocol';
import type { ChannelEvent } from '../inbox/render';
import type { MeshWindowContext } from '../window/context';
import { guardVersion } from '../window/guard-stamp';
import { relayPlatform, udsHex } from './address';
import { FORWARD_TTL_MS, forwardFile, removeForward, writeForward } from './forward-record';
import { readLocalSession } from './local-session';
import { pointerText } from './pointer';

export interface WindowRelayDeps {
  window: MeshWindowContext;
  agentId: string;
  prefix: string;
  /** This window's messaging address: local data, never logged or sent to the hub. */
  ownUds: string | null;
  /** This window's hub session. */
  ownSession: string | null;
  platform: NodeJS.Platform;
  now: number;
  push(event: ChannelEvent): Promise<void>;
}

const no = (reason: string): RelayAnswer => ({ forwarded: false, reason });

/**
 * The mesh window takes a hub `relay` for one of its human's private sessions: it resolves the
 * session's local record to its address, notes the pointer for its guard, and pushes the pointer
 * with `forward_to` for Claude to send. Each refusal names its reason; a reason never holds an
 * address (the ack goes to the hub).
 */
export async function forwardRelay(
  relay: SessionRelay,
  deps: WindowRelayDeps,
): Promise<RelayAnswer> {
  const { window, platform, now } = deps;
  if (window.state !== 'verified') return no('not the mesh window');
  if (!relayPlatform(platform)) return no(`relay is off on ${platform}`);
  const version = guardVersion(window.dataDir, now);
  if (!version || !isAtLeast(version, RELAY_MIN_VERSION)) {
    return no(`the guard is older than ${RELAY_MIN_VERSION} or not running`);
  }
  const { forSession } = relay;
  const record = readLocalSession(window.dataDir, deps.prefix, deps.agentId, forSession, now);
  if (!record || forSession === deps.ownSession) return no('no fresh record for that session');
  if (!record.relay) return no('that session turned relay off');
  const to = record.uds;
  const hex = udsHex(to, platform);
  if (!hex || to === null) return no('its address is not a valid local address');
  if (to === deps.ownUds) return no('that session is this window');
  const fields = { from: relay.from, threadId: relay.threadId, messageId: relay.messageId };
  const text = pointerText(fields);
  const name = forwardFile(hex, relay.messageId);
  if (!text || !name) return no('the pointer fields are invalid');
  try {
    writeForward(window.dataDir, hex, fields, now + FORWARD_TTL_MS);
  } catch {
    return no('could not write the guard record');
  }
  const meta = { kind: 'relay', thread_id: relay.threadId, message_id: relay.messageId };
  try {
    await deps.push({ content: text, meta: { ...meta, forward_to: to } });
  } catch {
    removeForward(window.dataDir, name);
    return no('the push failed');
  }
  return { forwarded: true, reason: 'forwarded' };
}
