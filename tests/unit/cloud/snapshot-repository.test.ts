import { describe, expect, it } from 'vitest';

import {
  assertCloudRevisionChain,
  type CloudRevisionInput
} from '../../../src/cloud/snapshot-repository.js';

describe('cloud snapshot CAS', () => {
  it('accepts the first revision and the next child revision', () => {
    const first: CloudRevisionInput = { revision: 1, parentRevision: null };
    const second: CloudRevisionInput = { revision: 2, parentRevision: 1 };

    expect(assertCloudRevisionChain(null, first)).toBe(1);
    expect(assertCloudRevisionChain(1, second)).toBe(2);
  });

  it('rejects a stale parent or a revision jump without overwriting the head', () => {
    expect(() => assertCloudRevisionChain(2, { revision: 3, parentRevision: 1 })).toThrowError(expect.objectContaining({ code: 'SYNC_CONFLICT' }));
    expect(() => assertCloudRevisionChain(2, { revision: 4, parentRevision: 2 })).toThrowError(expect.objectContaining({ code: 'SYNC_CONFLICT' }));
    expect(() => assertCloudRevisionChain(null, { revision: 2, parentRevision: null })).toThrowError(expect.objectContaining({ code: 'SYNC_CONFLICT' }));
  });
});
