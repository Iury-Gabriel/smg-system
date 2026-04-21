const Redis = require("ioredis");
const env = require("../config/env");

let redisClient = null;
let redisDisabled = false;

const inMemoryBuffers = new Map();

function logRedis(level, event, data) {
  const prefix = `[buffer-store][${new Date().toISOString()}][${event}]`;
  if (level === "error") {
    console.error(prefix, data || {});
    return;
  }
  if (level === "warn") {
    console.warn(prefix, data || {});
    return;
  }
  console.log(prefix, data || {});
}

function hasRedisConfigured() {
  return Boolean(String(env.redisUrl || "").trim());
}

function disableRedisClient() {
  redisDisabled = true;
  if (redisClient) {
    try {
      redisClient.disconnect();
    } catch (_error) {
      // noop
    }
  }
  redisClient = null;
}

function getRedisClient() {
  if (redisDisabled) return null;
  if (!hasRedisConfigured()) return null;
  if (redisClient) return redisClient;

  try {
    redisClient = new Redis(env.redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      enableOfflineQueue: false,
      lazyConnect: false,
      connectTimeout: 1200,
      retryStrategy: () => null,
      reconnectOnError: () => false,
    });

    redisClient.on("error", (error) => {
      logRedis("error", "client.error", {
        message: error?.message || "unknown",
        code: error?.code || null,
      });
      disableRedisClient();
    });

    redisClient.on("ready", () => {
      logRedis("info", "client.ready", {});
    });

    redisClient.on("end", () => {
      logRedis("warn", "client.end", {});
    });

    return redisClient;
  } catch (error) {
    logRedis("error", "client.init_failed", {
      message: error?.message || "unknown",
      code: error?.code || null,
    });
    disableRedisClient();
    return null;
  }
}

function buildRedisKey(segment) {
  const prefix = String(env.redisPrefix || "smg").trim();
  return `${prefix}:${segment}`;
}

async function pushBufferedMessage(bufferKey, messagePayload, ttlSeconds = 90) {
  const redis = getRedisClient();
  const encoded = JSON.stringify(messagePayload);

  if (redis) {
    try {
      await redis.rpush(bufferKey, encoded);
      await redis.expire(bufferKey, ttlSeconds);
      return;
    } catch (error) {
      logRedis("error", "push.failed", {
        bufferKey,
        ttlSeconds,
        message: error?.message || "unknown",
        code: error?.code || null,
      });
    }
  }

  const existing = inMemoryBuffers.get(bufferKey) || [];
  existing.push(encoded);
  inMemoryBuffers.set(bufferKey, existing);
}

async function popAllBufferedMessages(bufferKey) {
  const redis = getRedisClient();

  if (redis) {
    try {
      const transaction = redis.multi();
      transaction.lrange(bufferKey, 0, -1);
      transaction.del(bufferKey);
      const results = await transaction.exec();
      const rows = results?.[0]?.[1] || [];
      return rows
        .map((row) => {
          try {
            return JSON.parse(row);
          } catch (_error) {
            return null;
          }
        })
        .filter(Boolean);
    } catch (error) {
      logRedis("error", "pop.failed", {
        bufferKey,
        message: error?.message || "unknown",
        code: error?.code || null,
      });
    }
  }

  const rows = inMemoryBuffers.get(bufferKey) || [];
  inMemoryBuffers.delete(bufferKey);
  return rows
    .map((row) => {
      try {
        return JSON.parse(row);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

async function acquireLock(lockKey, ttlMs = 30000) {
  const redis = getRedisClient();

  if (redis) {
    try {
      const result = await redis.set(lockKey, "1", "PX", ttlMs, "NX");
      return result === "OK";
    } catch (error) {
      logRedis("error", "lock.acquire_failed", {
        lockKey,
        ttlMs,
        message: error?.message || "unknown",
        code: error?.code || null,
      });
    }
  }

  if (inMemoryBuffers.has(lockKey)) return false;
  inMemoryBuffers.set(lockKey, ["1"]);
  const timeout = setTimeout(() => {
    inMemoryBuffers.delete(lockKey);
  }, ttlMs);
  if (typeof timeout.unref === "function") {
    timeout.unref();
  }
  return true;
}

async function releaseLock(lockKey) {
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.del(lockKey);
      return;
    } catch (error) {
      logRedis("error", "lock.release_failed", {
        lockKey,
        message: error?.message || "unknown",
        code: error?.code || null,
      });
    }
  }
  inMemoryBuffers.delete(lockKey);
}

module.exports = {
  buildRedisKey,
  getRedisClient,
  hasRedisConfigured,
  pushBufferedMessage,
  popAllBufferedMessages,
  acquireLock,
  releaseLock,
};
