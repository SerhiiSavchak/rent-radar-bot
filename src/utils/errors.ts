export class AppError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(input: {
    code: string;
    message: string;
    retryable?: boolean | undefined;
    status?: number | undefined;
    details?: Record<string, unknown> | undefined;
    cause?: unknown;
  }) {
    super(input.message, input.cause !== undefined ? { cause: input.cause } : undefined);
    this.name = "AppError";
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    if (input.status !== undefined) {
      this.status = input.status;
    }
    if (input.details) {
      this.details = input.details;
    }
  }
}

export function isRetryableStatus(status: number): boolean {
  if (status === 401 || status === 403 || status === 404) {
    return false;
  }
  return status === 408 || status === 429 || status >= 500;
}
