import { execSync } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import { createClient } from "redis";
import type { IRedisClient } from "../../src/queues/types.js";

export interface ITestRedisClient extends IRedisClient {
  rPop(key: string): Promise<string | null>;
  lLen(key: string): Promise<number>;
  ttl(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
}

export interface RedisTestEnvironment {
  readonly url: string;
  readonly isLiveRedis: boolean;
  createClient(): Promise<ITestRedisClient>;
  cleanupKeys(pattern: string): Promise<void>;
  stop(): Promise<void>;
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to obtain free loopback port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function isRedisResponding(url: string, timeoutMs = 1500): Promise<boolean> {
  const client = createClient({
    url,
    socket: {
      connectTimeout: timeoutMs,
    },
  });

  try {
    await client.connect();
    const pong = await client.ping();
    await client.quit();
    return pong === "PONG";
  } catch {
    try {
      await client.disconnect();
    } catch {
      // Ignored
    }
    return false;
  }
}

/**
 * In-memory fallback client conforming to IRedisClient if neither external Redis
 * nor Docker is available in the test environment.
 */
class InMemoryRedisClient implements ITestRedisClient {
  public isOpen = true;
  private readonly store: Map<string, string>;
  private readonly lists: Map<string, string[]>;
  private readonly expirations: Map<string, number>;
  private readonly waiters: Array<{
    key: string;
    resolve: (res: { key: string; element: string } | null) => void;
  }>;

  constructor(
    sharedStore?: Map<string, string>,
    sharedLists?: Map<string, string[]>,
    sharedExpirations?: Map<string, number>,
    sharedWaiters?: Array<{
      key: string;
      resolve: (res: { key: string; element: string } | null) => void;
    }>,
  ) {
    this.store = sharedStore ?? new Map<string, string>();
    this.lists = sharedLists ?? new Map<string, string[]>();
    this.expirations = sharedExpirations ?? new Map<string, number>();
    this.waiters = sharedWaiters ?? [];
  }

  async connect(): Promise<void> {
    this.isOpen = true;
  }

  async disconnect(): Promise<void> {
    this.isOpen = false;
    for (const w of this.waiters) {
      w.resolve(null);
    }
    this.waiters.length = 0;
  }

  async quit(): Promise<void> {
    await this.disconnect();
  }

  async get(key: string): Promise<string | null> {
    const exp = this.expirations.get(key);
    if (exp !== undefined && Date.now() > exp) {
      this.store.delete(key);
      this.expirations.delete(key);
      return null;
    }
    return this.store.get(key) ?? null;
  }

  async mGet(keys: string[]): Promise<(string | null)[]> {
    return Promise.all(keys.map((k) => this.get(k)));
  }

  async set(
    key: string,
    value: string,
    options?: { NX?: boolean; EX?: number },
  ): Promise<string | null> {
    const existing = await this.get(key);
    if (options?.NX && existing !== null) {
      return null;
    }
    this.store.set(key, value);
    if (options?.EX !== undefined) {
      this.expirations.set(key, Date.now() + options.EX * 1000);
    } else {
      this.expirations.delete(key);
    }
    return "OK";
  }

  async del(keyOrKeys: string | string[]): Promise<number> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    let deleted = 0;
    for (const k of keys) {
      if (this.store.delete(k)) deleted++;
      this.expirations.delete(k);
      if (this.lists.delete(k)) deleted++;
    }
    return deleted;
  }

  async lPush(key: string, elements: string | string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    const items = Array.isArray(elements) ? elements : [elements];

    for (const item of items) {
      const waiterIdx = this.waiters.findIndex((w) => w.key === key);
      if (waiterIdx >= 0) {
        const waiter = this.waiters.splice(waiterIdx, 1)[0];
        if (waiter) {
          waiter.resolve({ key, element: item });
          continue;
        }
      }
      list.unshift(item);
    }
    this.lists.set(key, list);
    return list.length;
  }

  async rPop(key: string): Promise<string | null> {
    const list = this.lists.get(key);
    if (!list || list.length === 0) {
      return null;
    }
    return list.pop() ?? null;
  }

  async lLen(key: string): Promise<number> {
    const list = this.lists.get(key);
    return list ? list.length : 0;
  }

  async ttl(key: string): Promise<number> {
    const exists = this.store.has(key);
    if (!exists) {
      return -2;
    }
    const exp = this.expirations.get(key);
    if (exp === undefined) {
      return -1;
    }
    const remainingMs = exp - Date.now();
    if (remainingMs <= 0) {
      this.store.delete(key);
      this.expirations.delete(key);
      return -2;
    }
    return Math.ceil(remainingMs / 1000);
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    const results = new Set<string>();
    for (const k of this.store.keys()) {
      if (regex.test(k)) {
        const val = await this.get(k);
        if (val !== null) results.add(k);
      }
    }
    for (const k of this.lists.keys()) {
      if (regex.test(k)) results.add(k);
    }
    return Array.from(results);
  }

  async eval(
    script: string,
    options?: { keys?: string[]; arguments?: string[] },
  ): Promise<unknown> {
    // 1. Atomic deduplication script (checks all keys; sets all keys if none exist)
    if (script.includes("EXISTS")) {
      const keys = options?.keys ?? [];
      const ttlSec = options?.arguments?.[0] ? Number(options.arguments[0]) : 300;

      for (const k of keys) {
        const val = await this.get(k);
        if (val !== null) {
          return 0;
        }
      }

      for (const k of keys) {
        await this.set(k, "1", { EX: ttlSec });
      }

      return 1;
    }

    // 2. Fencing lock release script (DEL key if value == expectedValue)
    const key = options?.keys?.[0];
    const expectedValue = options?.arguments?.[0];
    if (key && expectedValue && (await this.get(key)) === expectedValue) {
      this.store.delete(key);
      this.expirations.delete(key);
      return 1;
    }
    return 0;
  }

  async blPop(
    keys: string | string[],
    timeoutSeconds: number,
  ): Promise<{ key: string; element: string } | null> {
    const targetKeys = Array.isArray(keys) ? keys : [keys];
    if (targetKeys.length === 0) {
      return null;
    }
    for (const key of targetKeys) {
      const list = this.lists.get(key);
      if (list && list.length > 0) {
        const item = list.pop();
        if (item !== undefined) {
          return { key, element: item };
        }
      }
    }

    const firstKey = targetKeys[0];
    if (!firstKey) {
      return null;
    }

    return new Promise<{ key: string; element: string } | null>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter = {
        key: firstKey,
        resolve: (val: { key: string; element: string } | null) => {
          if (timer) clearTimeout(timer);
          resolve(val);
        },
      };

      timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) {
          this.waiters.splice(idx, 1);
        }
        resolve(null);
      }, timeoutSeconds * 1000);
      timer.unref?.();

      this.waiters.push(waiter);
    });
  }

  duplicate(): IRedisClient {
    return new InMemoryRedisClient(this.store, this.lists, this.expirations, this.waiters);
  }
}

/**
 * Boots or attaches to a Redis instance for E2E and integration tests.
 * Priorities:
 * 1. process.env.REDIS_URL if accessible
 * 2. 127.0.0.1:6379 if running locally
 * 3. Ephemeral Docker container running redis:7-alpine on a free port
 * 4. In-memory client fallback if Docker is unavailable
 */
export async function setupRedisTestEnvironment(): Promise<RedisTestEnvironment> {
  const envUrl = process.env.REDIS_URL;
  if (envUrl && (await isRedisResponding(envUrl))) {
    return createLiveEnvironment(envUrl);
  }

  const defaultLocalUrl = "redis://127.0.0.1:6379";
  if (await isRedisResponding(defaultLocalUrl)) {
    return createLiveEnvironment(defaultLocalUrl);
  }

  // Attempt to spin up ephemeral Docker container
  try {
    const port = await getFreePort();
    const containerName = `redis-e2e-${crypto.randomBytes(4).toString("hex")}`;
    const dockerCmd = `docker run -d --name ${containerName} -p 127.0.0.1:${port}:6379 redis:7-alpine redis-server --save "" --appendonly no`;
    execSync(dockerCmd, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });

    const ephemeralUrl = `redis://127.0.0.1:${port}`;

    // Poll until Redis is ready (up to 7 seconds)
    const startTime = Date.now();
    let ready = false;
    while (Date.now() - startTime < 7000) {
      if (await isRedisResponding(ephemeralUrl, 500)) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    if (ready) {
      return {
        url: ephemeralUrl,
        isLiveRedis: true,
        createClient: async (): Promise<ITestRedisClient> => {
          const client = createClient({ url: ephemeralUrl });
          await client.connect();
          return client as unknown as ITestRedisClient;
        },
        cleanupKeys: async (pattern: string): Promise<void> => {
          const client = createClient({ url: ephemeralUrl });
          await client.connect();
          try {
            const keys = await client.keys(pattern);
            if (keys.length > 0) {
              await client.del(keys);
            }
          } finally {
            await client.quit();
          }
        },
        stop: async (): Promise<void> => {
          try {
            execSync(`docker rm -f ${containerName}`, {
              stdio: ["ignore", "ignore", "ignore"],
            });
          } catch {
            // Ignored
          }
        },
      };
    }
    // If not ready, clean up and fall back
    try {
      execSync(`docker rm -f ${containerName}`, {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      // Ignored
    }
  } catch {
    // Docker execution failed; fall through to in-memory fallback
  }

  // Fallback in-memory environment
  const sharedStore = new Map<string, string>();
  const sharedLists = new Map<string, string[]>();
  const sharedExpirations = new Map<string, number>();
  const sharedWaiters: Array<{
    key: string;
    resolve: (res: { key: string; element: string } | null) => void;
  }> = [];

  return {
    url: "memory://mock-redis",
    isLiveRedis: false,
    createClient: async (): Promise<ITestRedisClient> => {
      return new InMemoryRedisClient(sharedStore, sharedLists, sharedExpirations, sharedWaiters);
    },
    cleanupKeys: async (pattern: string): Promise<void> => {
      const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
      for (const k of Array.from(sharedStore.keys())) {
        if (regex.test(k)) sharedStore.delete(k);
      }
      for (const k of Array.from(sharedExpirations.keys())) {
        if (regex.test(k)) sharedExpirations.delete(k);
      }
      for (const k of Array.from(sharedLists.keys())) {
        if (regex.test(k)) sharedLists.delete(k);
      }
    },
    stop: async (): Promise<void> => {
      sharedStore.clear();
      sharedLists.clear();
      sharedExpirations.clear();
      sharedWaiters.length = 0;
    },
  };
}

function createLiveEnvironment(url: string): RedisTestEnvironment {
  return {
    url,
    isLiveRedis: true,
    createClient: async (): Promise<ITestRedisClient> => {
      const client = createClient({ url });
      await client.connect();
      return client as unknown as ITestRedisClient;
    },
    cleanupKeys: async (pattern: string): Promise<void> => {
      const client = createClient({ url });
      await client.connect();
      try {
        const keys = await client.keys(pattern);
        if (keys.length > 0) {
          await client.del(keys);
        }
      } finally {
        await client.quit();
      }
    },
    stop: async (): Promise<void> => {
      // External Redis was already running; nothing to kill
    },
  };
}
