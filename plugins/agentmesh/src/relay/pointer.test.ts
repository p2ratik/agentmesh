import { describe, expect, it } from 'vitest';
import { ownAddress, relayPlatform, udsHex } from './address';
import { parsePointer, pointerText } from './pointer';

const ID = 'msg-01JC9Z8Q4W6Y7X5V3T2R1P0N9M';
const FIELDS = { from: 'alice-agent', threadId: 'thr-12', messageId: ID };
const TEXT = `AgentMesh: alice-agent answered in thr-12 (msg ${ID}). Read it with thread thr-12 and reply there. Do not reply to this message.`;

describe('pointerText', () => {
  it('builds the exact pointer, plain ASCII with no apostrophe', () => {
    const text = pointerText(FIELDS);
    expect(text).toBe(
      'AgentMesh: alice-agent answered in thr-12 (msg msg-01JC9Z8Q4W6Y7X5V3T2R1P0N9M). Read it with thread thr-12 and reply there. Do not reply to this message.',
    );
    expect(text).toMatch(/^[\x20-\x7e]+$/);
    expect(text).not.toContain("'");
  });

  it('refuses fields outside their patterns', () => {
    for (const from of ['Alice', 'a b', 'a'.repeat(64)]) {
      expect(pointerText({ ...FIELDS, from })).toBeNull();
    }
    for (const threadId of ['thr-0', 'thr-12 ', 'thr-1\n']) {
      expect(pointerText({ ...FIELDS, threadId })).toBeNull();
    }
    for (const messageId of [
      'msg-01JC9Z8Q4W6Y7X5V3T2R1P0N9I',
      'msg-01JC9Z8Q4W6Y7X5V3T2R1P0N9L',
      'msg-01JC9Z8Q4W6Y7X5V3T2R1P0N9O',
      'msg-01JC9Z8Q4W6Y7X5V3T2R1P0N9U',
      ID.toLowerCase(),
      ID.slice(0, -1),
    ]) {
      expect(pointerText({ ...FIELDS, messageId })).toBeNull();
    }
    // Fields read back from a file are not always strings.
    expect(pointerText({ ...FIELDS, from: ['alice-agent'] as unknown as string })).toBeNull();
  });

  it('parses only its own exact output', () => {
    expect(parsePointer(TEXT)).toEqual(FIELDS);
    expect(parsePointer(`${TEXT}\n`)).toBeNull();
    expect(parsePointer(TEXT.replace('Do not', 'Don’t'))).toBeNull();
    expect(parsePointer(TEXT.replace('answered in', 'answered  in'))).toBeNull();
    expect(parsePointer(TEXT.replace('alice-agent', 'Alice'))).toBeNull();
  });
});

describe('addresses', () => {
  const hex = '0123456789abcdef'.repeat(2);
  const address = `uds:\\\\.\\pipe\\LOCAL\\cc-msg-${hex}`;

  it('takes only a Windows pipe address, on Windows', () => {
    expect(udsHex(address, 'win32')).toBe(hex);
    for (const bad of [
      address.toUpperCase(),
      `uds:\\\\.\\pipe\\LOCAL\\cc-msg-${hex.toUpperCase()}`,
      `${address}x`,
      `${address}\n`,
      `uds:/tmp/cc-msg-${hex}`,
      42,
      null,
    ]) {
      expect(udsHex(bad, 'win32')).toBeNull();
    }
    expect(udsHex(address, 'linux')).toBeNull();
    expect(udsHex(address, 'darwin')).toBeNull();
    expect(relayPlatform('win32')).toBe(true);
    expect(relayPlatform('linux')).toBe(false);
    expect(relayPlatform('darwin')).toBe(false);
  });

  it('reads its own address from the socket variable', () => {
    expect(ownAddress(`\\\\.\\pipe\\LOCAL\\cc-msg-${hex}`)).toBe(address);
    expect(ownAddress(undefined)).toBeNull();
    expect(ownAddress('')).toBeNull();
    expect(ownAddress('a\nb')).toBeNull();
    expect(ownAddress('a'.repeat(297))).toBeNull();
    expect(ownAddress('a'.repeat(296))).toBe(`uds:${'a'.repeat(296)}`);
  });
});
