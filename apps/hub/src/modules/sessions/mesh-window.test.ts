import { describe, expect, it } from 'vitest';
import { createBobDispatchHarness as setup } from '../../testing/services';

describe('the mesh window session', () => {
  /** A bob-agent session that hello marked as the mesh window, activated. */
  const withWindow = () => {
    const h = setup();
    const win = () => {
      const id = h.sessions.open('bob-agent', { clientVersion: '0.5.0', meshWindow: true }).session
        .id;
      h.sessions.activate('bob-agent', id, 'mesh window');
      return id;
    };
    return { ...h, win };
  };

  it('keeps the flag from hello and shows it in the active sessions', () => {
    const { active, win, sessions } = withWindow();
    active();
    win();
    expect(sessions.activeSessions('bob-agent').map((s) => s.meshWindow)).toEqual([false, true]);
  });

  it("routes a teammate's ask to the mesh window, not the session activated first", () => {
    const { active, win, thread, ask, sessions } = withWindow();
    active();
    const w = win();
    expect(sessions.route('bob-agent', ask(thread()))).toEqual({
      kind: 'deliver',
      sessionId: w,
      claim: true,
      reason: 'mesh window',
    });
  });
});
