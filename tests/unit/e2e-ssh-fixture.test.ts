import ssh2 from 'ssh2';
import { describe, expect, it } from 'vitest';

import { createE2eHostKey } from '../e2e/in-process-ssh-fixture.js';

const validEd25519Key = (() => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = ssh2.utils.generateKeyPairSync('ed25519').private;
    if (!(ssh2.utils.parseKey(candidate) instanceof Error)) return candidate;
  }
  throw new Error('could not generate a parseable Ed25519 test key');
})();

const malformedEd25519Key = (() => {
  const lines = validEd25519Key.trimEnd().split('\n');
  const body = Buffer.from(lines.slice(1, -1).join(''), 'base64').subarray(0, -1).toString('base64');
  const wrappedBody = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `${lines[0]}\n${wrappedBody}\n${lines.at(-1)}\n`;
})();

describe('in-process SSH fixture host key generation', () => {
  it('skips an ssh2-generated malformed Ed25519 key and returns a parseable key', () => {
    let calls = 0;
    const key = createE2eHostKey(() => ({
      private: calls++ === 0 ? malformedEd25519Key : validEd25519Key
    }));

    expect(calls).toBe(2);
    expect(ssh2.utils.parseKey(key)).not.toBeInstanceOf(Error);
  });
});
