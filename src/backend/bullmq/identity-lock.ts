import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
const IDENTITY_LOCK_TTL_MS = 60_000;
const IDENTITY_LOCK_WAIT_MS = 30_000;
const IDENTITY_LOCK_RETRY_MS = 10;
export const COMPARE_AND_DELETE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
export interface IdentityRedisClient {
  scan(
    cursor: string,
    match: 'MATCH',
    pattern: string,
    count: 'COUNT',
    amount: number,
  ): Promise<[string, string[]]>;
  get(key: string): Promise<string | null>;
  zscore(key: string, member: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, condition: 'NX'): Promise<'OK' | null>;
  set(
    key: string,
    value: string,
    expiryMode: 'PX',
    ttlMs: number,
    condition: 'NX',
  ): Promise<'OK' | null>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export async function withIdentityLocks<T>(
  queue: Queue,
  identities: Array<{ mapKey: string }>,
  action: (client: IdentityRedisClient) => Promise<T>,
): Promise<T> {
  const client = (await queue.client) as unknown as IdentityRedisClient;
  const token = randomUUID();
  const lockKeys = [...new Set(identities.map((identity) => `${identity.mapKey}:lock`))].sort();
  const acquired: string[] = [];

  try {
    for (const lockKey of lockKeys) {
      await acquireIdentityLock(client, lockKey, token);
      acquired.push(lockKey);
    }
    return await action(client);
  } finally {
    await Promise.allSettled(
      acquired
        .reverse()
        .map((lockKey) => client.eval(COMPARE_AND_DELETE_SCRIPT, 1, lockKey, token)),
    );
  }
}

async function acquireIdentityLock(
  client: IdentityRedisClient,
  lockKey: string,
  token: string,
): Promise<void> {
  const deadline = Date.now() + IDENTITY_LOCK_WAIT_MS;
  do {
    const result = await client.set(lockKey, token, 'PX', IDENTITY_LOCK_TTL_MS, 'NX');
    if (result === 'OK') return;
    await sleep(IDENTITY_LOCK_RETRY_MS);
  } while (Date.now() < deadline);

  throw new Error(`timed out acquiring BullMQ identity lock: ${lockKey}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
