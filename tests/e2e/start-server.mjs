/* global process */

import { rm } from 'node:fs/promises';

import { startServer } from '../../dist/server/index.js';

const dataDir = process.env.DATA_DIR;
if (dataDir !== '.tmp-e2e-data' && dataDir !== '.tmp-e2e-account-data') {
  throw new Error('the e2e server accepts only the isolated e2e data directories as DATA_DIR');
}

await rm(dataDir, { recursive: true, force: true });
const handle = await startServer();
let closing;

const shutdown = () => {
  if (!closing) {
    closing = handle.close().finally(async () => {
      await rm(dataDir, { recursive: true, force: true });
    });
  }
  return closing;
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void shutdown().then(() => process.exit(0), () => process.exit(1));
  });
}
