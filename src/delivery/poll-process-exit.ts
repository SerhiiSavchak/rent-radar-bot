/**
 * Process exit code for the Telegram poller.
 * An unbounded daemon stopped by SIGINT/SIGTERM exits 0 even after earlier
 * source or send failures. Finite runs still fail when those were observed.
 * Fatal exceptions are decided by the caller's catch block, not here.
 */
export function resolvePollProcessExitCode(input: {
  unbounded: boolean;
  gracefulStopRequested: boolean;
  operationalFailureObserved: boolean;
}): 0 | 1 {
  if (input.unbounded && input.gracefulStopRequested) {
    return 0;
  }
  if (input.operationalFailureObserved) {
    return 1;
  }
  return 0;
}
