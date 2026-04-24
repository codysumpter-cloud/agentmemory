export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: (error: unknown) => boolean;
}

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetriesOrOptions: number | RetryOptions = 3,
  baseDelayMs = 100,
  maxDelayMs = 5000,
  retryOn: (error: unknown) => boolean = () => true,
): Promise<T> {
  const options =
    typeof maxRetriesOrOptions === "number"
      ? { maxRetries: maxRetriesOrOptions, baseDelayMs, maxDelayMs, retryOn }
      : maxRetriesOrOptions;

  const maxRetries = options.maxRetries ?? 3;
  const baseDelay = options.baseDelayMs ?? 100;
  const maxDelay = options.maxDelayMs ?? 5000;
  const shouldRetry = options.retryOn ?? (() => true);

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      const exponentialDelay = baseDelay * 2 ** attempt;
      const jitter = Math.floor(Math.random() * baseDelay);
      const delay = Math.min(exponentialDelay + jitter, maxDelay);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
