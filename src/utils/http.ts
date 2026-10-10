import { AppError, isRetryableStatus } from "./errors.ts";

export type HttpResponse = {
  status: number;
  url: string;
  headers: Record<string, string>;
  bodyText: string;
  redirected: boolean;
};

export type HttpRequestOptions = {
  timeoutMs: number;
  headers?: Record<string, string>;
  maxRetries?: number;
  retryOn?: (status: number) => boolean;
};

const DEFAULT_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "Accept-Language": "uk-UA,uk;q=0.9,en;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Fetch headers and body, then settle even if `fetch` ignores abort.
 * The timeout timer is the last ref'd handle for a stalled request. Once it
 * fires, a still-pending `fetch` leaves the poller's top-level await with an
 * empty event loop and Node exits 13.
 */
async function fetchText(
  url: string,
  options: HttpRequestOptions,
): Promise<{
  status: number;
  url: string;
  headers: Headers;
  bodyText: string;
  redirected: boolean;
}> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      controller.abort();
      reject(new DOMException(`Request timed out: ${url}`, "AbortError"));
    }, options.timeoutMs);
  });
  // If the request wins, this rejection must not become unhandled.
  void timeout.catch(() => undefined);

  const request = (async () => {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        ...DEFAULT_HEADERS,
        ...options.headers,
      },
    });
    const bodyText = await response.text();
    return {
      status: response.status,
      url: response.url,
      headers: response.headers,
      bodyText,
      redirected: response.redirected,
    };
  })();
  // The caller stops waiting at the timeout. A later fetch rejection is not a new failure.
  void request.catch(() => undefined);

  try {
    return await Promise.race([request, timeout]);
  } finally {
    settled = true;
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function httpGet(url: string, options: HttpRequestOptions): Promise<HttpResponse> {
  const maxRetries = options.maxRetries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchText(url, options);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const result: HttpResponse = {
        status: response.status,
        url: response.url,
        headers,
        bodyText: response.bodyText,
        redirected: response.redirected,
      };

      const retryable = (options.retryOn ?? isRetryableStatus)(response.status);
      if (retryable && attempt < maxRetries) {
        await sleep(300 * 2 ** attempt);
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
      const aborted = isAbortError(error);
      if (attempt < maxRetries) {
        await sleep(300 * 2 ** attempt);
        continue;
      }
      throw new AppError({
        code: aborted ? "TIMEOUT" : "NETWORK",
        message: aborted ? `Request timed out: ${url}` : `Network error: ${url}`,
        retryable: true,
        cause: error,
      });
    }
  }

  throw new AppError({
    code: "NETWORK",
    message: `Request failed: ${url}`,
    retryable: true,
    cause: lastError,
  });
}

export function headerBag(response: HttpResponse): string {
  const interesting = ["content-type", "server", "x-cache", "cf-ray", "location"];
  return interesting
    .map((name) => (response.headers[name] ? `${name}=${response.headers[name]}` : undefined))
    .filter((item): item is string => Boolean(item))
    .join("; ");
}
