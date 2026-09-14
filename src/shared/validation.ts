import { z } from 'zod';

import { AppError } from './errors.js';

const MAX_HOST_NAME_LENGTH = 120;
const MAX_USERNAME_LENGTH = 255;
const MAX_TAG_LENGTH = 64;
const MAX_GROUP_ID_LENGTH = 128;

const hasControlCharacter = (value: string): boolean => [...value].some((character) => {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || codePoint === 0x7f;
});

const isValidIpv4 = (value: string): boolean => {
  const octets = value.split('.');
  return octets.length === 4 && octets.every((octet) => {
    if (!/^\d+$/u.test(octet) || octet.length > 3) {
      return false;
    }

    const number = Number(octet);
    return number >= 0 && number <= 255;
  });
};

const ipv6PartUnits = (part: string, isLast: boolean): number | null => {
  if (part.includes('.')) {
    return isLast && isValidIpv4(part) ? 2 : null;
  }

  return /^[0-9a-f]{1,4}$/iu.test(part) ? 1 : null;
};

const isValidIpv6 = (value: string): boolean => {
  if (value.includes('%') || value.startsWith('[') || value.endsWith(']')) {
    return false;
  }

  const compressionCount = value.match(/::/gu)?.length ?? 0;
  if (compressionCount > 1 || value.includes(':::')) {
    return false;
  }

  const hasCompression = compressionCount === 1;
  const [left, right = ''] = hasCompression ? value.split('::') : [value, ''];
  const leftParts = left === '' ? [] : left.split(':');
  const rightParts = right === '' ? [] : right.split(':');
  const parts = [...leftParts, ...rightParts];

  if (parts.length === 0) {
    return hasCompression;
  }

  let units = 0;
  for (const [index, part] of parts.entries()) {
    if (part === '') {
      return false;
    }

    const partUnits = ipv6PartUnits(part, index === parts.length - 1);
    if (partUnits === null) {
      return false;
    }

    units += partUnits;
  }

  return hasCompression ? units < 8 : units === 8;
};

const isValidHostname = (value: string): boolean => {
  if (value.length === 0 || value.length > 253 || hasControlCharacter(value) || /[\s/?#\\:]/u.test(value)) {
    return false;
  }

  return value.split('.').every((label) => (
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label)
  ));
};

export const isHostAddress = (value: string): boolean => {
  if (value.length === 0 || value.length > 253 || hasControlCharacter(value)) {
    return false;
  }

  if (isValidIpv4(value) || isValidIpv6(value)) {
    return true;
  }

  return isValidHostname(value);
};

const nameSchema = z.string()
  .min(1)
  .max(MAX_HOST_NAME_LENGTH)
  .refine((value) => !hasControlCharacter(value));

const usernameSchema = z.string()
  .min(1)
  .max(MAX_USERNAME_LENGTH)
  .refine((value) => !hasControlCharacter(value) && !/\s/u.test(value));

const tagSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_TAG_LENGTH)
  .refine((value) => !hasControlCharacter(value));

export const hostCredentialSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('password'),
    password: z.string().min(1).max(4096)
  }).strict(),
  z.object({
    type: z.literal('private_key'),
    privateKey: z.string().min(1).max(32768),
    passphrase: z.string().max(4096).optional()
  }).strict()
]);

export type HostCredentialInput = z.infer<typeof hostCredentialSchema>;

export const hostCreateSchema = z.object({
  name: nameSchema,
  address: z.string().refine(isHostAddress),
  port: z.number().int().min(1).max(65535).default(22),
  username: usernameSchema,
  auth: hostCredentialSchema,
  groupId: z.string().min(1).max(MAX_GROUP_ID_LENGTH).optional().nullable(),
  tags: z.array(tagSchema).max(20).default([]).transform((tags) => [...new Set(tags)]),
  isFavorite: z.boolean().default(false)
}).strict();

export type HostCreateInput = z.infer<typeof hostCreateSchema>;

export const hostPatchSchema = hostCreateSchema.partial();

export type HostPatchInput = z.infer<typeof hostPatchSchema>;

export interface HostMetadata {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authType: HostCredentialInput['type'];
  groupId: string | null;
  tags: string[];
  isFavorite: boolean;
  hostKeyAlgorithm: string | null;
  hostKeyFingerprint: string | null;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const groupSchema = z.object({
  name: nameSchema,
  sortOrder: z.number().int().min(0).max(1_000_000).default(0)
}).strict();

export type GroupInput = z.infer<typeof groupSchema>;

export const parseHostCreateInput = (input: unknown): HostCreateInput => {
  try {
    return hostCreateSchema.parse(input);
  } catch {
    throw new AppError('HOST_VALIDATION_FAILED');
  }
};

export const parseHostPatchInput = (input: unknown): HostPatchInput => {
  try {
    return hostPatchSchema.parse(input);
  } catch {
    throw new AppError('HOST_VALIDATION_FAILED');
  }
};
