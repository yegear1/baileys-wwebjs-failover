import { execSync } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import { createClient } from "redis";
import type { IRedisClient } from "../../src/queues/types.js";

export interface RedisTestEnvironment {
  readonly url: string;
  readonly isLiveRedis: boolean;
  createClient(): Promise<IRedisClient>;
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
class InMemoryRedisClient implements IRedisClient {
  public isOpen = true;
  private readonly store = new Map<string, string>();
  private readonly lists = new Map<string, string[]>();
  private readonly waiters: Array<{
    key: string;
    resolve: (res: { key: string; element: string } | null) => void;
  }> = [];

  constructor(sharedStore?: Map<string, string>, sharedLists?: Map<string, string[]>) {
    if (sharedStore) this.store = sharedStore;
    if (sharedLists) this.lists = sharedLists;
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

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async mGet(keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.store.get(k) ?? null);
  }

  async set(
    key: string,
    value: string,
    options?: { NX?: boolean; EX?: number },
  ): Promise<string | null> {
    if (options?.NX && this.store.has(key)) {
      return null;
    }
    this.store.set(key, value);
    return "OK";
  }

  async del(keyOrKeys: string | string[]): Promise<number> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    let deleted = 0;
    for (const k of keys) {
      if (this.store.delete(k)) deleted++;
      if (this.lists.delete(k)) deleted++;
    }
    return deleted;
  }

  async lPush(key: string, elements: string | string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    const items = Array.isArray(elements) ? elements : [elements];
    list.unshift(...items);
    this.lists.set(key, list);

    const waiterIdx = this.waiters.findIndex((w) => w.key === key);
    if (waiterIdx !== -1) {
      const waiter = this.waiters.splice(waiterIdx, 1)[0];
      const popped = list.pop();
      if (waiter && popped !== undefined) {
        waiter.resolve({ key, element: popped });
      }
    }

    return list.length;
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

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) {
          this.waiters.splice(idx, 1);
        }
        resolve(null);
      }, timeoutSeconds * 1000);

      this.waiters.push({
        key: firstKey,
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
      });
    });
  }

  duplicate(): IRedisClient {
    return new InMemoryRedisClient(this.store, this.lists);
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
        createClient: async (): Promise<IRedisClient> => {
          const client = createClient({ url: ephemeralUrl });
          await client.connect();
          return client as unknown as IRedisClient;
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

  return {
    url: "memory://mock-redis",
    isLiveRedis: false,
    createClient: async (): Promise<IRedisClient> => {
      return new InMemoryRedisClient(sharedStore, sharedLists);
    },
    cleanupKeys: async (pattern: string): Promise<void> => {
      const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
      for (const k of Array.from(sharedStore.keys())) {
        if (regex.test(k)) sharedStore.delete(k);
      }
      for (const k of Array.from(sharedLists.keys())) {
        if (regex.test(k)) sharedLists.delete(k);
      }
    },
    stop: async (): Promise<void> => {
      sharedStore.clear();
      sharedLists.clear();
    },
  };
}

function createLiveEnvironment(url: string): RedisTestEnvironment {
  return {
    url,
    isLiveRedis: true,
    createClient: async (): Promise<IRedisClient> => {
      const client = createClient({ url });
      await client.connect();
      return client as unknown as IRedisClient;
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
