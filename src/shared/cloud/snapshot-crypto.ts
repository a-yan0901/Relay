import { Sha256 } from '../crypto/sha256.js';
import { createCloudDataAad, parseCloudDataEnvelope, type CloudDataAadInput, type CloudDataEnvelope } from './protocol.js';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9_-]+$/u;

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
};

const toBase64Url = (value: Uint8Array): string => {
  let binary = '';
  for (const byte of value) binary += String.fromCodePoint(byte);
  return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

const fromBase64Url = (value: string): Uint8Array => {
  if (!BASE64_PATTERN.test(value) || value.length === 0) throw new Error('invalid snapshot encoding');
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = globalThis.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.codePointAt(index) ?? 0;
  return bytes;
};

const assertKey = (key: Uint8Array): void => {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) throw new Error('invalid snapshot key');
};

const assertPlaintext = (plaintext: Uint8Array): void => {
  if (!(plaintext instanceof Uint8Array) || plaintext.byteLength > MAX_SNAPSHOT_BYTES) throw new Error('snapshot too large');
};

const cryptoKey = (key: Uint8Array): Promise<globalThis.CryptoKey> => (
  globalThis.crypto.subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
);

const aadFor = (input: CloudDataAadInput): string => createCloudDataAad(input);

export interface CloudSnapshotCryptoInput extends CloudDataAadInput {
  dataKey: Uint8Array;
  plaintext: Uint8Array;
}

export const encryptCloudSnapshot = async (input: CloudSnapshotCryptoInput): Promise<CloudDataEnvelope> => {
  assertKey(input.dataKey);
  assertPlaintext(input.plaintext);
  const aad = aadFor(input);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const encrypted = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(new globalThis.TextEncoder().encode(aad)), tagLength: TAG_BYTES * 8 },
    await cryptoKey(input.dataKey),
    toArrayBuffer(input.plaintext)
  ));
  return {
    protocolVersion: 1,
    domain: input.domain,
    accountId: input.accountId,
    ...(input.domain === 'workspace' ? { workspaceId: input.workspaceId } : {}),
    revision: input.revision,
    parentRevision: input.parentRevision,
    writerDeviceId: input.writerDeviceId,
    keyVersion: input.keyVersion,
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(encrypted.subarray(0, -TAG_BYTES)),
    authTag: toBase64Url(encrypted.subarray(-TAG_BYTES)),
    aad,
    payloadHash: new Sha256().update(input.plaintext).digestHex(),
    byteLength: input.plaintext.byteLength
  };
};

export const decryptCloudSnapshot = async (envelope: unknown, dataKey: Uint8Array): Promise<Uint8Array> => {
  assertKey(dataKey);
  const parsed = parseCloudDataEnvelope(envelope);
  const nonce = fromBase64Url(parsed.nonce);
  const ciphertext = fromBase64Url(parsed.ciphertext);
  const authTag = fromBase64Url(parsed.authTag);
  if (nonce.byteLength !== NONCE_BYTES || authTag.byteLength !== TAG_BYTES || ciphertext.byteLength > MAX_SNAPSHOT_BYTES) throw new Error('invalid snapshot encoding');
  const encrypted = new Uint8Array(ciphertext.byteLength + authTag.byteLength);
  encrypted.set(ciphertext);
  encrypted.set(authTag, ciphertext.byteLength);
  const plaintext = new Uint8Array(await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(new globalThis.TextEncoder().encode(parsed.aad)), tagLength: TAG_BYTES * 8 },
    await cryptoKey(dataKey),
    toArrayBuffer(encrypted)
  ));
  if (plaintext.byteLength !== parsed.byteLength || new Sha256().update(plaintext).digestHex() !== parsed.payloadHash) throw new Error('snapshot integrity check failed');
  return plaintext;
};
