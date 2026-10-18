import { MeshError } from '@agentmesh/common';
import { decodeInvite, type InvitePayload } from '@agentmesh/protocol';

export interface InviteSummary {
  payload: InvitePayload;
  /** `host:port` the code points at: what the human must recognise before joining. */
  hub: string;
}

/**
 * Decodes an invite code and checks this plugin can use it. Errors never echo
 * the code: it is a bearer secret until redeemed.
 */
export function readInvite(code: string): InviteSummary {
  const payload = decodeInvite(code);
  const url = new URL(payload.natsUrl);
  if (url.protocol === 'wss:' || url.protocol === 'ws:') {
    throw new MeshError(
      'invalid_request',
      'This invite uses a websocket URL, which the plugin cannot connect to yet. Ask your admin for a tls:// invite.',
    );
  }
  return { payload, hub: url.port ? `${url.hostname}:${url.port}` : url.hostname };
}

/** The question the human answers before anything connects. */
export function confirmationText(summary: InviteSummary): string {
  const { payload, hub } = summary;
  return `This invite joins the mesh at ${hub} as ${payload.agentId} (subject prefix "${payload.prefix}", invite ${payload.inviteId}).`;
}
