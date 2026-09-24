/** Reject when `work` does not settle within `timeoutMs`. The caller still owns `work`. */
export function awaitWithTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const budget = Math.max(1, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${budget}ms`));
    }, budget);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}
