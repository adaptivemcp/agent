import type { DecisionBackend, SystemOneQuestion, SystemOneResponse } from "./systemone.js";

/**
 * Options for {@link TieredSystemOneBackend}.
 */
export interface TieredSystemOneBackendOptions {
  /**
   * Total wall-clock budget for one `answer()` call across **all** tiers, in
   * milliseconds. Default 8000 (the same default as a single backend). The
   * budget is split evenly across the tiers that remain: each tier races its
   * slice, so a hung primary cannot consume the whole budget and starve the
   * fallback, and failover can never double the decision latency.
   */
  budgetMs?: number;
  /**
   * Called when a tier fails **and the next tier's attempt actually starts**
   * (it is not called when the budget runs out before the fallback runs).
   * The provider-level `onError` is *not* invoked on a recovered fallback — it
   * means "the decision layer declined", which only happens when every tier
   * errors. Use this to count fallbacks programmatically.
   */
  onFallback?: (error: unknown, from: DecisionBackend, to: DecisionBackend) => void;
}

/**
 * A `DecisionBackend` that fans one decision out over up to two backends in
 * `tier` order (local first, remote second), falling through to the next tier
 * only when a tier **errors** (connection refused, timeout, 4xx/5xx,
 * unparseable reply).
 *
 * A low-confidence verdict is deliberately *not* a fallback trigger: the tier
 * answered, and the advisor is the component that declines on confidence — so
 * failover never second-guesses a model's actual answer.
 *
 * Ordering and caps (both enforced at construction, so `answer()` cannot
 * violate them):
 *
 * - Backends are sorted by `tier` (asc, stable); callers may pass them in any
 *   order.
 * - **One fallback per decision call**: at most a primary plus one fallback
 *   tier — constructing with more than two backends throws. Keeping the cap
 *   structural is what keeps the System-1 fast path fast.
 *
 * The tier that produced the last successful answer is exposed via
 * {@link TieredSystemOneBackend.attribution} so hosts (e.g.
 * `lastDecisionSummary()`) can show which tier answered and whether it was a
 * fallback.
 */
export class TieredSystemOneBackend implements DecisionBackend {
  readonly id: string;
  readonly model: string;
  readonly tier: number;
  private readonly ordered: DecisionBackend[];
  private readonly budgetMs: number;
  private readonly onFallback?: TieredSystemOneBackendOptions["onFallback"];
  private lastAnsweredBy?: DecisionBackend;
  private fellBackFrom?: string;

  constructor(backends: DecisionBackend[], options: TieredSystemOneBackendOptions = {}) {
    if (backends.length === 0) {
      throw new Error("TieredSystemOneBackend needs at least one backend");
    }
    if (backends.length > 2) {
      throw new Error(
        `TieredSystemOneBackend allows one fallback per decision call (a primary plus one ` +
          `fallback tier), but got ${backends.length} backends`,
      );
    }
    if (options.budgetMs !== undefined && !(options.budgetMs > 0)) {
      throw new Error(`TieredSystemOneBackend budgetMs must be > 0, got ${options.budgetMs}`);
    }
    // Stable sort: equal tiers keep the caller's order, lower tiers run first.
    this.ordered = [...backends].sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0));
    this.budgetMs = options.budgetMs ?? 8000;
    this.onFallback = options.onFallback;
    this.tier = this.ordered[0]!.tier ?? 0;
    this.model = this.ordered[0]!.model;
    this.id = `tiered(${this.ordered.map((backend) => backend.id).join(",")})`;
  }

  /** The id of the backend whose answer the last *successful* call returned. */
  get answeredBy(): string | undefined {
    return this.lastAnsweredBy?.id;
  }

  /**
   * Which tier produced the last verdict: `<answered id>`, or
   * `<answered id> (fell back from <failed id>)` when the primary errored
   * first; `(no tier answered yet)` before the first successful call. A failed
   * call leaves the previous attribution in place — the host summary pairs it
   * with the last successful decision anyway.
   */
  attribution(): string {
    const answered = this.lastAnsweredBy;
    if (!answered) return "(no tier answered yet)";
    return this.fellBackFrom ? `${answered.id} (fell back from ${this.fellBackFrom})` : answered.id;
  }

  async answer(
    state: unknown,
    questions: Record<string, SystemOneQuestion>,
  ): Promise<SystemOneResponse> {
    const deadline = Date.now() + this.budgetMs;
    const errors: unknown[] = [];
    for (let i = 0; i < this.ordered.length; i += 1) {
      const backend = this.ordered[i]!;
      // Fair share: every remaining tier gets an equal slice of what is left,
      // so a hung primary cannot eat the budget the fallback needs.
      const slice = Math.floor((deadline - Date.now()) / (this.ordered.length - i));
      if (slice <= 0) {
        errors.push(new Error(`system one: ${this.id} exhausted its ${this.budgetMs}ms budget`));
        break;
      }
      if (i > 0) this.onFallback?.(errors.at(-1), this.ordered[i - 1]!, backend);
      try {
        const response = await withTimeout(backend.answer(state, questions), slice);
        this.lastAnsweredBy = backend;
        this.fellBackFrom = i > 0 ? this.ordered[i - 1]!.id : undefined;
        return response;
      } catch (error) {
        errors.push(error);
      }
    }
    // One tier failed → surface its error untouched; both failed → let the
    // host see the local *and* the remote failure instead of only the last.
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(errors, `system one: every tier failed (${this.id})`);
  }
}

/** Reject with a timeout when `promise` does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`system one: tier attempt exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => resolve(value),
      (error) => reject(error),
    );
  }).finally(() => clearTimeout(timer));
}
