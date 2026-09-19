import type { DatabaseSync } from "node:sqlite";

export class PollerLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PollerLockError";
  }
}

export type PollerLock = {
  holder: string;
  heartbeat: () => void;
  release: () => void;
};

export function acquirePollerLock(
  db: DatabaseSync,
  holder: string,
  staleMs = 15 * 60_000,
  now = () => new Date(),
): PollerLock {
  const at = now().toISOString();
  db.exec("BEGIN IMMEDIATE;");
  try {
    const existing = db.prepare("SELECT holder, heartbeat_at AS heartbeatAt FROM poller_lock WHERE id = 1").get() as
      | { holder: string; heartbeatAt: string }
      | undefined;
    if (existing && existing.holder !== holder) {
      const age = now().getTime() - new Date(existing.heartbeatAt).getTime();
      if (Number.isFinite(age) && age < staleMs) {
        db.exec("ROLLBACK;");
        throw new PollerLockError(
          `Another poller holds the lock (${existing.holder}). Stop it before starting a second instance.`,
        );
      }
    }
    db.prepare(
      `INSERT INTO poller_lock (id, holder, acquired_at, heartbeat_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at`,
    ).run(holder, at, at);
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
