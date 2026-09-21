import { z } from "zod";

export type SoakCycleStatus = "complete" | "degraded" | "failed";
export type SoakVerdict = "PASS" | "DEGRADED" | "FAIL" | "ABORTED";

export type SoakSourceId = "domria" | "lun" | "rieltor" | "olx_browser" | "olx_http";

export type SoakSourceResult = {
  source: SoakSourceId;
  success: boolean;
  /** Counts toward cycle complete/degraded/failed. olx_http is diagnostic-only. */
  required: boolean;
  transport: string;
  classification: string;
  resultKind?: string;
  httpStatus?: number;
  extractedCount: number;
  elapsedMs: number;
  errorSafe?: string;
  notes?: string[];
};

export type SoakMemorySnapshot = {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
};

export type SoakCycleReport = {
  experiment: "oracle-soak";
  cycle: number;
  startedAt: string;
  endedAt: string;
  status: SoakCycleStatus;
  elapsedMs: number;
  memoryBefore: SoakMemorySnapshot;
  memoryAfter: SoakMemorySnapshot;
  sources: SoakSourceResult[];
  fatal?: boolean;
  fatalReason?: string;
};

export type SoakSummary = {
  experiment: "oracle-soak";
  startedAt: string;
  endedAt: string;
  commit: string;
  runtime: {
    node: string;
    platform: string;
    arch: string;
    totalElapsedMs: number;
  };
  config: {
    cyclesRequested: number;
    intervalMs: number;
    outDir: string;
  };
  totals: {
    cyclesAttempted: number;
    complete: number;
    degraded: number;
    failed: number;
  };
  perSourceSuccessRate: Record<string, { success: number; total: number; rate: number }>;
  repeatedFailureStreaks: Record<string, number>;
  maxRssBytes: number;
  maxCycleDurationMs: number;
  stoppedEarly: boolean;
  stopReason?: string;
  verdict: SoakVerdict;
  note: string;
};

export const soakSourceResultSchema = z.object({
  source: z.enum(["domria", "lun", "rieltor", "olx_browser", "olx_http"]),
  success: z.boolean(),
  required: z.boolean(),
  transport: z.string(),
  classification: z.string(),
  resultKind: z.string().optional(),
  httpStatus: z.number().optional(),
  extractedCount: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
  errorSafe: z.string().optional(),
  notes: z.array(z.string()).optional(),
});

export const soakCycleReportSchema = z.object({
  experiment: z.literal("oracle-soak"),
  cycle: z.number().int().positive(),
  startedAt: z.string().min(1),
  endedAt: z.string().min(1),
  status: z.enum(["complete", "degraded", "failed"]),
  elapsedMs: z.number().nonnegative(),
  memoryBefore: z.object({
    rssBytes: z.number(),
    heapUsedBytes: z.number(),
    externalBytes: z.number(),
  }),
  memoryAfter: z.object({
    rssBytes: z.number(),
    heapUsedBytes: z.number(),
    externalBytes: z.number(),
  }),
  sources: z.array(soakSourceResultSchema).min(1),
  fatal: z.boolean().optional(),
  fatalReason: z.string().optional(),
});

export const soakSummarySchema = z.object({
  experiment: z.literal("oracle-soak"),
  startedAt: z.string(),
  endedAt: z.string(),
  commit: z.string(),
  runtime: z.object({
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
    totalElapsedMs: z.number(),
  }),
  config: z.object({
    cyclesRequested: z.number(),
    intervalMs: z.number(),
    outDir: z.string(),
  }),
  totals: z.object({
    cyclesAttempted: z.number(),
    complete: z.number(),
    degraded: z.number(),
    failed: z.number(),
  }),
  perSourceSuccessRate: z.record(
    z.string(),
    z.object({ success: z.number(), total: z.number(), rate: z.number() }),
  ),
  repeatedFailureStreaks: z.record(z.string(), z.number()),
  maxRssBytes: z.number(),
  maxCycleDurationMs: z.number(),
  stoppedEarly: z.boolean(),
  stopReason: z.string().optional(),
  verdict: z.enum(["PASS", "DEGRADED", "FAIL", "ABORTED"]),
  note: z.string(),
});
