const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPER_VERSION = 1 as const;
const SCHEME = 'ecdh-p256-aesgcm-v1' as const;
const SAFE_BASE64 = /^[A-Za-z0-9_-]+$/u;

type PortableJwk = Record<string, unknown>;
interface PortableCryptoKeyPair { publicKey: globalThis.CryptoKey; privateKey: globalThis.CryptoKey; }

export interface CloudDeviceKeyPair {
  publicKey: string;
  privateKey: string;
}

export interface WrappedCloudDataKey {
  scheme: typeof SCHEME;
  version: typeof WRAPPER_VERSION;
  curve: 'P-256';
  ephemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
}

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
  if (typeof value !== 'string' || value.length === 0 || !SAFE_BASE64.test(value)) throw new Error('invalid cloud key wrapper');
  let binary: string;
  try {
    const padded = value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - value.length % 4) % 4);
    binary = globalThis.atob(padded);
  } catch {
    throw new Error('invalid cloud key wrapper');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.codePointAt(index) ?? 0;
  return bytes;
};

const encodeJwk = (key: PortableJwk): string => toBase64Url(new globalThis.TextEncoder().encode(JSON.stringify(key)));

const decodeJwk = (value: unknown): PortableJwk => {
  const bytes = fromBase64Url(value);
  if (bytes.byteLength > 8 * 1024) throw new Error('invalid cloud device key');
  try {
    const parsed: unknown = JSON.parse(new globalThis.TextDecoder().decode(bytes));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('key object expected');
    return parsed as PortableJwk;
  } catch {
    throw new Error('invalid cloud device key');
  }
};

const importPublicKey = (serialized: string): Promise<globalThis.CryptoKey> => (
  globalThis.crypto.subtle.importKey('jwk', decodeJwk(serialized), { name: 'ECDH', namedCurve: 'P-256' }, true, [])
);

const importPrivateKey = (serialized: string): Promise<globalThis.CryptoKey> => (
  globalThis.crypto.subtle.importKey('jwk', decodeJwk(serialized), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'])
);

const assertDataKey = (value: Uint8Array): void => {
  if (!(value instanceof Uint8Array) || value.byteLength !== KEY_BYTES) throw new Error('invalid cloud data key');
};

const aadBytes = (aad: string): ArrayBuffer => {
  if (typeof aad !== 'string' || aad.length === 0 || aad.length > 512) throw new Error('invalid cloud key aad');
  return toArrayBuffer(new globalThis.TextEncoder().encode(aad));
};

const deriveWrappingKey = (privateKey: globalThis.CryptoKey, publicKey: globalThis.CryptoKey): Promise<globalThis.CryptoKey> => (
  globalThis.crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
);

export const generateCloudDeviceKeyPair = async (): Promise<CloudDeviceKeyPair> => {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  ) as PortableCryptoKeyPair;
  const publicJwk = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey) as unknown as PortableJwk;
  const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey) as unknown as PortableJwk;
  return { publicKey: encodeJwk(publicJwk), privateKey: encodeJwk(privateJwk) };
};

const parseWrapper = (value: Record<string, unknown>): WrappedCloudDataKey => {
  const keys = Object.keys(value);
  if (keys.length !== 7 || keys.some((key) => !['scheme', 'version', 'curve', 'ephemeralPublicKey', 'nonce', 'ciphertext', 'authTag'].includes(key))) {
    throw new Error('invalid cloud key wrapper');
  }
  if (value.scheme !== SCHEME || value.version !== WRAPPER_VERSION || value.curve !== 'P-256') throw new Error('invalid cloud key wrapper');
  const nonce = fromBase64Url(value.nonce);
  const ciphertext = fromBase64Url(value.ciphertext);
  const authTag = fromBase64Url(value.authTag);
  if (nonce.byteLength !== NONCE_BYTES || authTag.byteLength !== TAG_BYTES || ciphertext.byteLength !== KEY_BYTES) throw new Error('invalid cloud key wrapper');
  decodeJwk(value.ephemeralPublicKey);
  return value as unknown as WrappedCloudDataKey;
};

export const wrapCloudDataKey = async (
  dataKey: Uint8Array,
  recipientPublicKey: string,
  aad: string
): Promise<WrappedCloudDataKey> => {
  assertDataKey(dataKey);
  const recipient = await importPublicKey(recipientPublicKey);
  const ephemeral = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']) as PortableCryptoKeyPair;
  const wrappingKey = await deriveWrappingKey(ephemeral.privateKey, recipient);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const encrypted = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: aadBytes(aad), tagLength: TAG_BYTES * 8 },
    wrappingKey,
    toArrayBuffer(dataKey)
  ));
  const publicJwk = await globalThis.crypto.subtle.exportKey('jwk', ephemeral.publicKey) as unknown as PortableJwk;
  return {
    scheme: SCHEME,
    version: WRAPPER_VERSION,
    curve: 'P-256',
    ephemeralPublicKey: encodeJwk(publicJwk),
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(encrypted.subarray(0, -TAG_BYTES)),
    authTag: toBase64Url(encrypted.subarray(-TAG_BYTES))
  };
};

export const unwrapCloudDataKey = async (
  value: unknown,
  recipientPrivateKey: string,
  aad: string
): Promise<Uint8Array> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid cloud key wrapper');
  const wrapper = parseWrapper(value as Record<string, unknown>);
  const privateKey = await importPrivateKey(recipientPrivateKey);
  const ephemeralPublicKey = await importPublicKey(wrapper.ephemeralPublicKey);
  const wrappingKey = await deriveWrappingKey(privateKey, ephemeralPublicKey);
  const ciphertext = fromBase64Url(wrapper.ciphertext);
  const authTag = fromBase64Url(wrapper.authTag);
  const encrypted = new Uint8Array(ciphertext.byteLength + authTag.byteLength);
  encrypted.set(ciphertext);
  encrypted.set(authTag, ciphertext.byteLength);
  const plaintext = new Uint8Array(await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(fromBase64Url(wrapper.nonce)), additionalData: aadBytes(aad), tagLength: TAG_BYTES * 8 },
    wrappingKey,
    toArrayBuffer(encrypted)
  ));
  assertDataKey(plaintext);
  return plaintext;
};
