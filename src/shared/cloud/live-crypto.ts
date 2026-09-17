import { decodeLiveFrame, encodeLiveFrame, LIVE_MAX_FRAME_BYTES, parseLiveFrame, type LiveFrame } from './live-protocol.js';

const LIVE_CRYPTO_VERSION = 1 as const;
const AES_KEY_BYTES = 32;
const AES_NONCE_BYTES = 12;
const BASE64_PATTERN = /^[A-Za-z0-9_-]+$/u;

interface LiveCipherEnvelope {
  protocolVersion: typeof LIVE_CRYPTO_VERSION;
  aad: string;
  nonce: string;
  ciphertext: string;
}

const assertKey = (key: Uint8Array): void => {
  if (!(key instanceof Uint8Array) || key.byteLength !== AES_KEY_BYTES) throw new Error('invalid live session key');
};

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

const fromBase64Url = (value: unknown): Uint8Array => {
  if (typeof value !== 'string' || value.length === 0 || !BASE64_PATTERN.test(value)) throw new Error('invalid live ciphertext');
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - value.length % 4) % 4);
  let binary: string;
  try {
    binary = globalThis.atob(padded);
  } catch {
    throw new Error('invalid live ciphertext');
  }
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.codePointAt(index) ?? 0;
  return result;
};

const cryptoKey = (key: Uint8Array): Promise<globalThis.CryptoKey> => (
  globalThis.crypto.subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
);

export interface LiveSessionKeyContext {
  workspaceId: string;
  ownerDeviceId: string;
  viewerDeviceId: string;
  ownerEpoch: number;
}

/** Derive a short-lived per-viewer key without retaining a key registry in the relay. */
export const deriveLiveSessionKey = async (baseKey: Uint8Array, context: LiveSessionKeyContext): Promise<Uint8Array> => {
  assertKey(baseKey);
  if (
    typeof context.workspaceId !== 'string' || context.workspaceId.length === 0 || context.workspaceId.length > 128
    || typeof context.ownerDeviceId !== 'string' || context.ownerDeviceId.length === 0 || context.ownerDeviceId.length > 128
    || typeof context.viewerDeviceId !== 'string' || context.viewerDeviceId.length === 0 || context.viewerDeviceId.length > 128
    || !Number.isSafeInteger(context.ownerEpoch) || context.ownerEpoch < 1
  ) throw new Error('invalid live session key context');
  const hmacKey = await globalThis.crypto.subtle.importKey(
    'raw',
    toArrayBuffer(baseKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const material = new globalThis.TextEncoder().encode(
    `relay-live-key:v1:${context.workspaceId}:${context.ownerDeviceId}:${context.viewerDeviceId}:${context.ownerEpoch}`
  );
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', hmacKey, toArrayBuffer(material)));
};

const associatedData = (frame: LiveFrame): string => `relay-live:v${LIVE_CRYPTO_VERSION}:${frame.workspaceId}`;

const parseCipherEnvelope = (bytes: Uint8Array): LiveCipherEnvelope => {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > LIVE_MAX_FRAME_BYTES) throw new Error('live frame too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new globalThis.TextDecoder().decode(bytes));
  } catch {
    throw new Error('invalid live cipher envelope');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid live cipher envelope');
  const candidate = parsed as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length !== 4 || !keys.every((key) => ['protocolVersion', 'aad', 'nonce', 'ciphertext'].includes(key))) throw new Error('invalid live cipher envelope');
  if (candidate.protocolVersion !== LIVE_CRYPTO_VERSION || typeof candidate.aad !== 'string' || candidate.aad.length > 256) throw new Error('invalid live cipher envelope');
  const nonce = fromBase64Url(candidate.nonce);
  const ciphertext = fromBase64Url(candidate.ciphertext);
  if (nonce.byteLength !== AES_NONCE_BYTES || ciphertext.byteLength === 0 || ciphertext.byteLength > LIVE_MAX_FRAME_BYTES) throw new Error('invalid live cipher envelope');
  return {
    protocolVersion: LIVE_CRYPTO_VERSION,
    aad: candidate.aad,
    nonce: candidate.nonce as string,
    ciphertext: candidate.ciphertext as string
  };
};

export const encryptLiveFrame = async (key: Uint8Array, frame: LiveFrame): Promise<Uint8Array> => {
  assertKey(key);
  const validated = parseLiveFrame(frame);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(AES_NONCE_BYTES));
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(new globalThis.TextEncoder().encode(associatedData(validated))) },
    await cryptoKey(key),
    toArrayBuffer(encodeLiveFrame(validated))
  );
  const envelope: LiveCipherEnvelope = {
    protocolVersion: LIVE_CRYPTO_VERSION,
    aad: associatedData(validated),
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(new Uint8Array(encrypted))
  };
  const bytes = new globalThis.TextEncoder().encode(JSON.stringify(envelope));
  if (bytes.byteLength > LIVE_MAX_FRAME_BYTES) throw new Error('live frame too large');
  return bytes;
};

export const decryptLiveFrame = async (key: Uint8Array, bytes: Uint8Array): Promise<LiveFrame> => {
  assertKey(key);
  const envelope = parseCipherEnvelope(bytes);
  const decrypted = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(fromBase64Url(envelope.nonce)), additionalData: toArrayBuffer(new globalThis.TextEncoder().encode(envelope.aad)) },
    await cryptoKey(key),
    toArrayBuffer(fromBase64Url(envelope.ciphertext))
  );
  return decodeLiveFrame(new Uint8Array(decrypted));
};
