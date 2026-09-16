import type { SoakCycleReport, SoakCycleStatus, SoakSourceResult, SoakVerdict } from "./types.ts";

/** Required sources for cycle health. olx_http is diagnostic-only (known 403). */
export const SOAK_REQUIRED_SOURCES = ["domria", "lun", "rieltor", "olx_browser"] as const;

export function classifyCycleStatus(sources: SoakSourceResult[]): SoakCycleStatus {
  const required = sources.filter((s) => s.required);
  if (required.length === 0) {
    return "failed";
  }
  const ok = required.filter((s) => s.success).length;
  if (ok === required.length) {
    return "complete";
  }
  if (ok === 0) {
    return "failed";
  }
  return "degraded";
}

export function classifyHttpAdapterResult(input: {
  httpStatus?: number;
  resultKind?: string;
  extractedCount: number;
  healthy?: boolean;
}): { success: boolean; classification: string } {
  if (input.httpStatus === 403 || input.httpStatus === 429) {
    return { success: false, classification: "transport_blocked" };
  }
  if (input.resultKind === "parser_failure") {
    return { success: false, classification: "parser_failure" };
  }
  if (input.resultKind === "ok" && input.extractedCount > 0) {
    return { success: true, classification: "ok" };
  }
  if (input.resultKind === "valid_empty") {
    return { success: true, classification: "valid_empty" };
  }
  if (input.httpStatus !== undefined && input.httpStatus >= 400) {
    return { success: false, classification: "http_error" };
  }
  return { success: false, classification: input.resultKind ?? "no_listings" };
}

export function maxFailureStreaks(cycles: SoakCycleReport[]): Record<string, number> {
  const streaks: Record<string, number> = {};
  const current: Record<string, number> = {};
  for (const cycle of cycles) {
    for (const source of cycle.sources) {
      if (source.success) {
        current[source.source] = 0;
      } else {
        current[source.source] = (current[source.source] ?? 0) + 1;
        streaks[source.source] = Math.max(streaks[source.source] ?? 0, current[source.source] ?? 0);
      }
    }
  }
  return streaks;
}

export function buildPerSourceSuccessRate(
  cycles: SoakCycleReport[],
): Record<string, { success: number; total: number; rate: number }> {
  const map: Record<string, { success: number; total: number }> = {};
  for (const cycle of cycles) {
    for (const source of cycle.sources) {
      const row = map[source.source] ?? { success: 0, total: 0 };
      row.total += 1;
      if (source.success) {
        row.success += 1;
      }
      map[source.source] = row;
    }
  }
  const out: Record<string, { success: number; total: number; rate: number }> = {};
  for (const [key, value] of Object.entries(map)) {
    out[key] = {
      ...value,
      rate: value.total === 0 ? 0 : value.success / value.total,
    };
  }
  return out;
}

export function decideSoakVerdict(input: {
  cycles: SoakCycleReport[];
  cyclesRequested: number;
  stoppedEarly: boolean;
  abortedBySignal: boolean;
  fatalStop: boolean;
}): SoakVerdict {
  if (input.abortedBySignal) {
    return "ABORTED";
  }
  if (input.fatalStop) {
    return "FAIL";
  }
  const complete = input.cycles.filter((c) => c.status === "complete").length;
  const failed = input.cycles.filter((c) => c.status === "failed").length;
  if (input.cycles.length === 0) {
    return "FAIL";
  }
  if (!input.stoppedEarly && complete === input.cyclesRequested) {
    return "PASS";
  }
  if (failed === input.cycles.length) {
    return "FAIL";
  }
  return "DEGRADED";
}

export function buildSummaryNote(verdict: SoakVerdict): string {
  if (verdict === "PASS") {
    return "Two-hour-class soak window passed cycle completeness checks only. Does not prove multi-day reliability.";
  }
  if (verdict === "DEGRADED") {
    return "Soak finished with mixed cycle health. Not multi-day proof.";
  }
  if (verdict === "ABORTED") {
    return "Soak aborted by signal before completing requested cycles.";
  }
  return "Soak failed (fatal stop or all cycles failed). Not multi-day proof.";
}
