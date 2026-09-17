import { AsyncLocalStorage } from 'node:async_hooks';

export const DEFAULT_OWNER_ID = 'default';

const ownerStorage = new AsyncLocalStorage<string>();

export const currentOwnerId = (): string => ownerStorage.getStore() ?? DEFAULT_OWNER_ID;

/** Set the owner for the current request's async execution chain. */
export const enterOwnerContext = (ownerId: string): void => {
  ownerStorage.enterWith(ownerId);
};

export const runWithOwnerId = <T>(ownerId: string, callback: () => T): T => ownerStorage.run(ownerId, callback);
