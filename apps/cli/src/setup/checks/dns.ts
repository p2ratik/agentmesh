import { lookup } from 'node:dns/promises';
import type { CheckResult } from './result';

/** The system resolver (the one ssh uses), as a list of addresses. */
export const lookupAddresses = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true })).map((a) => a.address);

export async function checkDns(
  host: string,
  resolve: (h: string) => Promise<string[]>,
): Promise<CheckResult> {
  const addresses = await resolve(host).catch(() => []);
  if (addresses.length === 0) {
    return {
      ok: false,
      label: `${host} does not resolve`,
      detail: 'Point an A record at the server, wait a minute, and run again.',
    };
  }
  return { ok: true, label: `${host} resolves to ${addresses.join(', ')}` };
}
