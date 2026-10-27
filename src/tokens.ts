import type { TokenUsage } from "./types";

function isUsage(value: unknown): value is TokenUsage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Add provider counters, including nested cache/reasoning counters. */
export function sumUsage(...usages: TokenUsage[]): TokenUsage {
  const totals = new Map<string, unknown>();
  for (const usage of usages) {
    for (const [key, value] of Object.entries(usage)) {
      const previous = totals.get(key);
      if (typeof value === "number" && Number.isFinite(value)) {
        totals.set(key, (typeof previous === "number" ? previous : 0) + value);
      } else if (isUsage(value)) {
        totals.set(key, sumUsage(isUsage(previous) ? previous : {}, value));
      } else {
        totals.set(key, value);
      }
    }
  }
  return Object.fromEntries(totals);
}

/** One allocation of the total ToA budget, shared by every request in its tool loop. */
export class CompletionBudget {
  remaining: number;
  usage: TokenUsage = {};

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Completion budget must be a positive integer.");
    this.remaining = limit;
  }

  record(usage: TokenUsage, requested: number): void {
    this.usage = sumUsage(this.usage, usage);
    const reported = usage.completion_tokens ?? usage.output_tokens;
    // Missing usage must not make the limit unenforceable. Reserve the entire
    // request allowance conservatively, without inventing reported usage.
    const charged = typeof reported === "number" && Number.isSafeInteger(reported) && reported >= 0
      ? reported : requested;
    this.remaining = Math.max(0, this.remaining - charged);
  }
}
