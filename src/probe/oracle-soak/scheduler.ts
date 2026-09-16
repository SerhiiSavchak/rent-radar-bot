export type SoakSchedulerOptions = {
  cycles: number;
  intervalMs: number;
  runCycle: (cycle: number) => Promise<{ stopFatal?: boolean; stopReason?: string } | void>;
  sleep: (ms: number) => Promise<void>;
  shouldStop: () => boolean;
};

export type SoakSchedulerResult = {
  cyclesAttempted: number;
  stoppedEarly: boolean;
  stopReason?: string;
  overlapDetected: boolean;
};

/**
 * Sequential cycles only. Sleeps intervalMs after each cycle except the last.
 * The next cycle starts only after `await runCycle` resolves (no overlap).
 */
export async function runSoakScheduler(options: SoakSchedulerOptions): Promise<SoakSchedulerResult> {
  let cyclesAttempted = 0;
  let stoppedEarly = false;
  let stopReason: string | undefined;
  // Overlap is structurally impossible while we await runCycle; flag kept for evidence/tests.
  const overlapDetected = false;

  for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
    if (options.shouldStop()) {
      stoppedEarly = true;
      stopReason = stopReason ?? "signal";
      break;
    }
    cyclesAttempted += 1;
    const result = await options.runCycle(cycle);
    if (result?.stopFatal) {
      stoppedEarly = true;
      stopReason = result.stopReason ?? "fatal";
      break;
    }
    if (options.shouldStop()) {
      stoppedEarly = true;
      stopReason = stopReason ?? "signal";
      break;
    }
    if (cycle < options.cycles) {
      await options.sleep(options.intervalMs);
    }
  }

  return {
    cyclesAttempted,
    stoppedEarly,
    ...(stopReason !== undefined ? { stopReason } : {}),
    overlapDetected,
  };
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
