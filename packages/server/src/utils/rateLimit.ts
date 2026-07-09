// 简单 in-memory token bucket + 账号临时锁. 进程重启清空 (个人 / 自部署场景接受).
// 后续 Q5 会把 groups.ts 的 ipBuckets 也迁移过来复用同一份.

export interface TokenBucketConfig {
  windowMs: number;
  max: number;
}

export interface TokenBucket {
  check(key: string): boolean;
  reset(key: string): void;
  peek(key: string): { count: number; resetAt: number } | undefined;
}

export function createTokenBucket({ windowMs, max }: TokenBucketConfig): TokenBucket {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  // 定期清过期 bucket 防 Map 无限增长. 5 min 一次扫
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (b.resetAt < now) buckets.delete(k);
    }
  }, 5 * 60 * 1000).unref?.();

  return {
    check(key: string): boolean {
      const now = Date.now();
      const b = buckets.get(key);
      if (!b || b.resetAt < now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      if (b.count >= max) return false;
      b.count++;
      return true;
    },
    reset(key: string) {
      buckets.delete(key);
    },
    peek(key: string) {
      return buckets.get(key);
    },
  };
}

// 账号临时锁 (登录失败超阈值锁 30min). 独立于 bucket, 因为语义是 "锁到某时间点" 而非 "N 次 / 窗口".
export interface AccountLock {
  lock(key: string, durationMs: number): void;
  isLocked(key: string): boolean;
  unlock(key: string): void;
  peek(key: string): number | undefined; // 返回 unlockAt (毫秒时间戳) 或 undefined
}

export function createAccountLock(): AccountLock {
  const locks = new Map<string, number>();

  setInterval(() => {
    const now = Date.now();
    for (const [k, unlockAt] of locks) {
      if (unlockAt < now) locks.delete(k);
    }
  }, 5 * 60 * 1000).unref?.();

  return {
    lock(key: string, durationMs: number) {
      locks.set(key, Date.now() + durationMs);
    },
    isLocked(key: string): boolean {
      const unlockAt = locks.get(key);
      if (!unlockAt) return false;
      if (unlockAt < Date.now()) {
        locks.delete(key);
        return false;
      }
      return true;
    },
    unlock(key: string) {
      locks.delete(key);
    },
    peek(key: string) {
      const unlockAt = locks.get(key);
      if (!unlockAt) return undefined;
      if (unlockAt < Date.now()) {
        locks.delete(key);
        return undefined;
      }
      return unlockAt;
    },
  };
}

// 从 Hono ctx 拿 client IP. 反代场景走 x-forwarded-for 首个 IP, 否则 x-real-ip, 兜底 'unknown'
// 注意: x-forwarded-for 是用户可控 header, 反代未信任 IP 时可被伪造 → 攻击者绕 rate limit
// (Q5 待办: 部署时收紧到反代白名单. 当前个人 / 自部署场景接受)
export function getClientIp(headers: {
  'x-forwarded-for'?: string;
  'x-real-ip'?: string;
  [k: string]: string | undefined;
}): string {
  const xff = headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return headers['x-real-ip'] || 'unknown';
}
