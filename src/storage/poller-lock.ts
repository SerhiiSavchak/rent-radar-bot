import { readFileSync } from "node:fs";
import { uptime } from "node:os";
import type { DatabaseSync } from "node:sqlite";

export class PollerLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PollerLockError";
  }
}

export const DEFAULT_LOCK_STALE_MS = 15 * 60_000;

export type PollerLock = {
  holder: string;
  bootId: string;
  pid: number;
  starttime: string;
  heartbeat: () => void;
  release: () => void;
};

export type AcquirePollerLockOptions = {
  staleMs?: number;
  now?: () => Date;
  bootId?: string;
  pid?: number;
  starttime?: string;
  isProcessAlive?: (pid: number, starttime: string) => boolean;
  cmdlineLooksLikePoller?: (pid: number) => boolean;
};

type LockRow = {
  holder: string;
  heartbeatAt: string;
  bootId: string | null;
  pid: number | null;
  starttime: string | null;
};

function normalizeOptions(
  staleMsOrOptions: number | AcquirePollerLockOptions,
  nowArg?: () => Date,
): Required<Pick<AcquirePollerLockOptions, "staleMs" | "now">> & AcquirePollerLockOptions {
  if (typeof staleMsOrOptions === "number") {
    return { staleMs: staleMsOrOptions, now: nowArg ?? (() => new Date()) };
  }
  return {
    staleMs: staleMsOrOptions.staleMs ?? DEFAULT_LOCK_STALE_MS,
    now: staleMsOrOptions.now ?? nowArg ?? (() => new Date()),
    ...staleMsOrOptions,
  };
}

export function readOsBootId(): string {
  try {
    const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (id) {
      return id;
    }
  } catch {
    // Windows / containers without the proc file.
  }
  return `uptime:${Math.floor(Date.now() / 1000 - uptime())}`;
}

export function readPidStarttime(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closed = stat.lastIndexOf(")");
    if (closed === -1) {
      return "";
    }
    const rest = stat.slice(closed + 2).split(/\s+/);
    return rest[19] ?? "";
  } catch {
    return "";
  }
}

export function processIsAlive(pid: number, starttime: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (process.platform === "linux" || process.platform === "android") {
    const actual = readPidStarttime(pid);
    if (!actual) {
      return false;
    }
    if (starttime && actual !== starttime) {
      return false;
    }
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function cmdlineLooksLikePoller(pid: number): boolean {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return /test-telegram-poll|test-telegram-canary|test-telegram\.ts|telegram-poll/.test(cmd);
  } catch {
    return false;
  }
}

export function parsePidFromHolder(holder: string): number | undefined {
  const legacy = holder.match(/^telegram-(?:poll|oneshot|canary):(\d+)$/);
  return legacy ? Number(legacy[1]) : undefined;
}

export function formatLockHolder(role: string, bootId: string, pid: number, starttime: string): string {
  return `${role}:${bootId}:${pid}:${starttime || "0"}`;
}

function isLiveOwner(
  row: LockRow,
  currentBootId: string,
  isAlive: (pid: number, starttime: string) => boolean,
  looksLikePoller: (pid: number) => boolean,
): boolean {
  const starttime = row.starttime ?? "";
  const pid = row.pid && row.pid > 0 ? row.pid : parsePidFromHolder(row.holder);
  if (!pid) {
    return false;
  }
  if (row.bootId && row.bootId !== currentBootId) {
    return false;
  }
  if (row.bootId && row.bootId === currentBootId) {
    return isAlive(pid, starttime);
  }
  // Legacy schema-v2 row: no boot id. Trust only a still-running poller cmdline.
  return isAlive(pid, starttime) && looksLikePoller(pid);
}

export function acquirePollerLock(
  db: DatabaseSync,
  role: string,
  staleMsOrOptions: number | AcquirePollerLockOptions = DEFAULT_LOCK_STALE_MS,
  nowArg?: () => Date,
): PollerLock {
  const options = normalizeOptions(staleMsOrOptions, nowArg);
  const now = options.now;
  const bootId = options.bootId ?? readOsBootId();
  const pid = options.pid ?? process.pid;
  const starttime = options.starttime ?? readPidStarttime(pid);
  const holder = formatLockHolder(role, bootId, pid, starttime);
  const isAlive = options.isProcessAlive ?? processIsAlive;
  const looksLikePoller = options.cmdlineLooksLikePoller ?? cmdlineLooksLikePoller;
  const at = now().toISOString();
  void options.staleMs;

  db.exec("BEGIN IMMEDIATE;");
  try {
    const existing = db
      .prepare(
        `SELECT holder, heartbeat_at AS heartbeatAt, boot_id AS bootId, pid, starttime
         FROM poller_lock WHERE id = 1`,
      )
      .get() as LockRow | undefined;

    if (existing && existing.holder !== holder) {
      const live = isLiveOwner(existing, bootId, isAlive, looksLikePoller);
      if (live) {
        db.exec("ROLLBACK;");
        throw new PollerLockError(
          `Another poller holds the lock (${existing.holder}). Stop it before starting a second instance.`,
        );
      }
    }

    db.prepare(
      `INSERT INTO poller_lock (id, holder, acquired_at, heartbeat_at, boot_id, pid, starttime)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         holder = excluded.holder,
         acquired_at = excluded.acquired_at,
         heartbeat_at = excluded.heartbeat_at,
         boot_id = excluded.boot_id,
         pid = excluded.pid,
         starttime = excluded.starttime`,
    ).run(holder, at, at, bootId, pid, starttime);
    db.exec("COMMIT;");
  } catch (error) {
    if (error instanceof PollerLockError) {
      throw error;
    }
    try {
      db.exec("ROLLBACK;");
    } catch {
      // already rolled back
    }
    throw error;
  }

  return {
    holder,
    bootId,
    pid,
    starttime,
    heartbeat: () => {
      db.prepare("UPDATE poller_lock SET heartbeat_at = ? WHERE id = 1 AND holder = ?").run(
        now().toISOString(),
        holder,
      );
    },
    release: () => {
      db.prepare("DELETE FROM poller_lock WHERE id = 1 AND holder = ?").run(holder);
    },
  };
}
