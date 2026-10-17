import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome } from './paths';

describe('expandHome', () => {
  it('expands only a leading ~ segment', () => {
    expect(expandHome('~/.agentmesh/a.nk', '/home/x')).toBe(join('/home/x', '.agentmesh/a.nk'));
    expect(expandHome('~\\keys\\a.nk', 'C:\\Users\\x')).toBe(join('C:\\Users\\x', 'keys\\a.nk'));
    expect(expandHome('~', '/home/x')).toBe('/home/x');
    expect(expandHome('~bob/a.nk', '/home/x')).toBe('~bob/a.nk');
    expect(expandHome('/abs/a.nk', '/home/x')).toBe('/abs/a.nk');
  });
});
