import { AppError } from '../../shared/errors.js';
import { ARGON2ID_PARAMS } from '../vault/types.js';

export const ACCOUNT_PASSWORD_MIN_LENGTH = 8;
export const ACCOUNT_PASSWORD_MAX_LENGTH = 4096;

// This is only used to make unknown-account sign-in perform the same expensive
// verification path as a known account. It is not a user credential.
const DUMMY_ACCOUNT_PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const assertPassword = (password: string): void => {
  if (
    typeof password !== 'string' ||
    password.length < ACCOUNT_PASSWORD_MIN_LENGTH ||
    password.length > ACCOUNT_PASSWORD_MAX_LENGTH
  ) {
    throw new AppError('ACCOUNT_PASSWORD_INVALID');
  }
};

export const hashAccountPassword = async (password: string): Promise<string> => {
  assertPassword(password);
  const argon2 = await import('argon2');
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: ARGON2ID_PARAMS.memoryCost,
    timeCost: ARGON2ID_PARAMS.timeCost,
    parallelism: ARGON2ID_PARAMS.parallelism,
    hashLength: ARGON2ID_PARAMS.hashLength
  });
};

export const verifyAccountPassword = async (password: string, passwordHash: string): Promise<boolean> => {
  if (typeof password !== 'string' || password.length > ACCOUNT_PASSWORD_MAX_LENGTH || typeof passwordHash !== 'string') {
    return false;
  }

  try {
    const argon2 = await import('argon2');
    return await argon2.verify(passwordHash, password);
  } catch {
    return false;
  }
};

export const verifyAccountPasswordOrDummy = async (
  password: string,
  passwordHash: string | null
): Promise<boolean> => verifyAccountPassword(password, passwordHash ?? DUMMY_ACCOUNT_PASSWORD_HASH);
