import { describe, expect, it } from 'vitest';
import { createBobDispatchHarness } from '../../testing/services';
import type { SessionsServiceImpl } from './sessions.service';

describe('session.hello reusing an open session', () => {
  // The relay's version gate reads the row: a plugin updated in place must not keep its old version.
  it('refreshes the client version from the hello', () => {
    const h = createBobDispatchHarness();
    const { repo } = h.sessions as SessionsServiceImpl;
    const id = h.sessions.open('bob-agent', { clientVersion: '0.5.0' }).session.id;
    const again = h.sessions.open('bob-agent', { clientVersion: '0.6.0', previousSessionId: id });
    expect(again.session.id).toBe(id);
    expect(repo.get(id)?.client_version).toBe('0.6.0');
  });
});
