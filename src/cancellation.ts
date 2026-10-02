/** Waits without losing cancellation while sleeping or awaiting a tool. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // The caller may have started an operation just before the signal changed.
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    const abort = (): void => { cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}

export function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = (): void => { cleanup(); reject(signal?.reason); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
