import { DEFAULT_CATEGORY } from '@cosmicwave/config';
import { describe, expect, it } from 'vitest';
import { pickCategory } from './provision';

describe('pickCategory', () => {
  it('finds the configured category by name', () => {
    const c = { name: 'Robots' };
    expect(pickCategory([{ name: 'Agent Mesh' }, c], 'Robots')).toBe(c);
  });

  it('uses an existing "Agent Mesh" category when the wanted name is the default', () => {
    const c = { name: 'Agent Mesh' };
    expect(pickCategory([{ name: 'x' }, c], DEFAULT_CATEGORY)).toBe(c);
  });

  it('prefers the default-named category over the old one', () => {
    const c = { name: DEFAULT_CATEGORY };
    expect(pickCategory([{ name: 'Agent Mesh' }, c], DEFAULT_CATEGORY)).toBe(c);
  });

  it('does not fall back for a name the team chose', () => {
    expect(pickCategory([{ name: 'Agent Mesh' }], 'Robots')).toBeUndefined();
  });
});
