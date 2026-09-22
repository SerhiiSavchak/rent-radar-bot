import type { DatabaseSync } from "node:sqlite";
import {
  isFailureSourceStatus,
  isHealthySourceStatus,
  readSourceHealth,
  safeStoredError,
  type SourceHealthRow,
} from "../storage/source-health.ts";

export const SOURCE_ALERT_FAILURE_THRESHOLD = 3;
export const SOURCE_ALERT_FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export type SourceAlertSend = (text: string) => Promise<{ ok: boolean; errorSafe?: string }>;

export type SourceAlertReport = {
  sent: number;
  failed: number;
  errors: string[];
};

type AlertRow = {
  incidentOpen: number;
  cooldownUntil: string | null;
};

export function formatSourceIncidentAlert(row: SourceHealthRow): string {
  return [
    "Rent Radar source alert",
    `source: ${row.source}`,
    `status: ${row.status}`,
    `consecutive_failures: ${row.consecutiveFailures}`,
    `last_success_at: ${row.lastSuccessAt ?? "none"}`,
    `error: ${row.lastErrorSafe ?? row.status}`,
  ].join("\n");
}

export function formatSourceRecoveryAlert(row: SourceHealthRow): string {
  return [
    "Rent Radar source recovered",
    `source: ${row.source}`,
    `status: ${row.status}`,
    `last_success_at: ${row.lastSuccessAt ?? "none"}`,
  ].join("\n");
}

export async function dispatchSourceAdminAlerts(
  db: DatabaseSync,
  now: Date,
  send: SourceAlertSend,
): Promise<SourceAlertReport> {
  const report: SourceAlertReport = { sent: 0, failed: 0, errors: [] };
  const sources = db.prepare("SELECT source FROM source_health ORDER BY source").all() as Array<{
    source: string;
  }>;
  for (const item of sources) {
    const health = readSourceHealth(db, item.source);
    if (!health || health.status === "disabled") {
      continue;
    }
    const alert = readAlert(db, item.source);
    const cooling =
      alert?.cooldownUntil !== null &&
      alert?.cooldownUntil !== undefined &&
      Date.parse(alert.cooldownUntil) > now.getTime();
    if (isHealthySourceStatus(health.status)) {
      if (!alert || alert.incidentOpen !== 1 || cooling) {
        continue;
      }
      await deliver(
        db,
        health.source,
        "recovery",
        formatSourceRecoveryAlert(health),
        now,
        send,
        report,
        true,
      );
      continue;
    }
    if (!isFailureSourceStatus(health.status)) {
      continue;
    }
    if (health.consecutiveFailures < SOURCE_ALERT_FAILURE_THRESHOLD) {
      continue;
    }
    if (alert?.incidentOpen === 1 || cooling) {
      continue;
    }
    await deliver(
      db,
      health.source,
      "incident",
      formatSourceIncidentAlert(health),
      now,
      send,
      report,
      false,
    );
  }
  return report;
}

async function deliver(
  db: DatabaseSync,
  source: string,
  kind: "incident" | "recovery",
  text: string,
  now: Date,
  send: SourceAlertSend,
  report: SourceAlertReport,
  clearIncident: boolean,
): Promise<void> {
  let result: { ok: boolean; errorSafe?: string };
  try {
    result = await send(text);
  } catch (error) {
    result = {
      ok: false,
      errorSafe: error instanceof Error ? error.message : "admin alert failed",
    };
  }
  if (result.ok) {
    writeAlert(db, source, {
      incidentOpen: clearIncident ? 0 : 1,
      kind,
      at: now,
      cooldownUntil: null,
      errorSafe: null,
    });
    report.sent += 1;
    return;
  }
  const errorSafe = safeStoredError(result.errorSafe, "admin_alert") ?? "admin alert failed";
  writeAlert(db, source, {
    incidentOpen: clearIncident ? 1 : 0,
    kind,
    at: now,
    cooldownUntil: new Date(now.getTime() + SOURCE_ALERT_FAILURE_COOLDOWN_MS).toISOString(),
    errorSafe,
  });
  report.failed += 1;
  if (report.errors.length < 10) {
    report.errors.push(`${source}: ${errorSafe}`);
  }
}

function readAlert(db: DatabaseSync, source: string): AlertRow | undefined {
  return db
    .prepare(
      `SELECT incident_open AS incidentOpen, cooldown_until AS cooldownUntil
       FROM source_admin_alerts WHERE source = ?`,
    )
    .get(source) as AlertRow | undefined;
}

function writeAlert(
  db: DatabaseSync,
  source: string,
  input: {
    incidentOpen: number;
    kind: string;
    at: Date;
    cooldownUntil: string | null;
    errorSafe: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO source_admin_alerts (
       source, incident_open, last_alert_kind, last_alert_at, cooldown_until, last_error_safe, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET
       incident_open = excluded.incident_open,
       last_alert_kind = excluded.last_alert_kind,
       last_alert_at = excluded.last_alert_at,
       cooldown_until = excluded.cooldown_until,
       last_error_safe = excluded.last_error_safe,
       updated_at = excluded.updated_at`,
  ).run(
    source,
    input.incidentOpen,
    input.kind,
    input.at.toISOString(),
    input.cooldownUntil,
    input.errorSafe,
    input.at.toISOString(),
  );
}
