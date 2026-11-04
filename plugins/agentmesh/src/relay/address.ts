// Built-ins only (the hook and guard bundles import this). An address is local data: never
// logged, never sent to the hub.

/** A Claude Code messaging address on Windows: `uds:` and a local named pipe. */
export const WINDOWS_UDS = /^uds:\\\\\.\\pipe\\LOCAL\\cc-msg-([0-9a-f]{32})$/;

/** Whether the relay runs on this platform: only where an address pattern has been verified. */
export const relayPlatform = (platform: NodeJS.Platform): boolean => platform === 'win32';

/** The 32-hex part of a valid address, or null. */
export function udsHex(address: unknown, platform: NodeJS.Platform): string | null {
  // ponytail: no POSIX pattern until Sagar's probe (Task 12b); POSIX sessions use the note.
  if (platform !== 'win32' || typeof address !== 'string') return null;
  return WINDOWS_UDS.exec(address)?.[1] ?? null;
}

/** This session's address, from `CLAUDE_CODE_MESSAGING_SOCKET`; null when unset or odd. */
export function ownAddress(socket: string | undefined): string | null {
  if (!socket) return null;
  const address = `uds:${socket}`;
  return address.length <= 300 && !/[\r\n]/.test(address) ? address : null;
}
