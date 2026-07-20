// QMD retrieval orchestration shared between the plugin and bench (ADR 0005,
// issue #56). Ports the query-execution half of the frozen legacy wrapper
// scripts/aha/run-insight-search.mjs: runQmdPlanQuery / runQmdPlanQueryCommand
// / runQmdPlanQueries / isQmdRetryableTimeout.
//
// The injected `runQmdQuery` dep owns exactly the adapter's duty per ADR 0005:
// building argv, closing stdin, enforcing the per-call timeout, and bounding
// output size — then resolving with the raw stdout text (or rejecting with an
// Error whose message includes "timed out after" on a timeout, which is how
// this module's retry policy recognizes a timeout versus any other failure).
// Core owns everything downstream: serial execution over the plan's queries,
// the 30s default timeout policy, retryable-timeout warning semantics (warn,
// never downgrade the query kind), row-array parsing, and the structured
// {queryResults, warnings, errors} shape.
//
// This module must stay free of `obsidian` imports, node imports, and
// module-level I/O.

export interface QmdQueryLike {
  kind: string;
  command: string;
  text?: string;
  query?: string;
  qmd?: unknown;
}

export interface QmdRow {
  file?: unknown;
  path?: unknown;
  uri?: unknown;
  title?: unknown;
  snippet?: unknown;
  score?: unknown;
  [key: string]: unknown;
}

/** Byte-identical to DEFAULT_QMD_QUERY_TIMEOUT_MS in the legacy wrapper. */
export const DEFAULT_QMD_QUERY_TIMEOUT_MS = 30_000;

export interface QmdDeps {
  /**
   * Runs exactly one query end to end (argv construction, closed stdin,
   * `timeoutMs` enforcement, bounded stdout/stderr) and resolves with the raw
   * stdout text. Must reject with an Error whose message includes
   * "timed out after" when the call times out.
   */
  runQmdQuery(query: QmdQueryLike, timeoutMs: number): Promise<string>;
}

export interface QmdPolicy {
  /** Per-query timeout budget in ms. Defaults to DEFAULT_QMD_QUERY_TIMEOUT_MS. */
  queryTimeoutMs?: number;
}

export interface QmdQueryOutcome {
  query: QmdQueryLike;
  rows: QmdRow[];
  warning?: string;
}

export interface QmdPlanQueriesResult {
  queryResults: QmdQueryOutcome[];
  warnings: string[];
  errors: string[];
}

/**
 * Verbatim port of isQmdRetryableTimeout: only a plain "qmd query" timeout is
 * retried once; "qmd search" and other commands are not, and non-timeout
 * failures are never retried.
 */
export function isQmdRetryableTimeout(error: unknown, query: QmdQueryLike): boolean {
  const command = String(query.command || "qmd query");
  const message = error instanceof Error ? error.message : String(error);
  return command === "qmd query" && message.includes("timed out after");
}

/**
 * Verbatim port of the JSON-array extraction runQmdPlanQueryCommand applies
 * to raw qmd CLI stdout: find the outermost bracket pair and JSON.parse it.
 */
export function extractQmdRows(output: string): QmdRow[] {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("QMD output did not include a JSON array.");
  }
  return JSON.parse(output.slice(start, end + 1));
}

/**
 * Runs one plan query, retrying exactly once on a retryable timeout (warning,
 * never downgrading the query kind), matching runQmdPlanQuery verbatim.
 */
export async function runQmdPlanQuery(query: QmdQueryLike, deps: QmdDeps, policy: QmdPolicy = {}): Promise<QmdQueryOutcome> {
  const timeoutMs = policy.queryTimeoutMs ?? DEFAULT_QMD_QUERY_TIMEOUT_MS;
  try {
    const stdout = await deps.runQmdQuery(query, timeoutMs);
    return { query, rows: extractQmdRows(stdout) };
  } catch (error) {
    if (!isQmdRetryableTimeout(error, query)) throw error;
    const firstMessage = error instanceof Error ? error.message : String(error);
    try {
      const stdout = await deps.runQmdQuery(query, timeoutMs);
      return {
        query,
        rows: extractQmdRows(stdout),
        warning: `${query.kind}/${query.command} timed out once (${firstMessage}); retry succeeded with qmd query.`,
      };
    } catch (retryError) {
      const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(`${firstMessage}; retry failed: ${retryMessage}`);
    }
  }
}

type Settled =
  | { ok: true; result: QmdQueryOutcome }
  | { ok: false; error: string };

/**
 * Runs the plan's queries serially, exactly like runQmdPlanQueries: each
 * query's failure is caught independently (never aborting the remaining
 * queries), and results are partitioned into queryResults/warnings/errors.
 */
export async function runQmdPlanQueries(queries: QmdQueryLike[], deps: QmdDeps, policy: QmdPolicy = {}): Promise<QmdPlanQueriesResult> {
  const settled: Settled[] = [];
  for (const query of queries) {
    try {
      settled.push({ ok: true, result: await runQmdPlanQuery(query, deps, policy) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      settled.push({ ok: false, error: `${query.kind}/${query.command}: ${message}` });
    }
  }
  return {
    queryResults: settled.filter((item): item is { ok: true; result: QmdQueryOutcome } => item.ok).map((item) => item.result),
    warnings: settled
      .filter((item): item is { ok: true; result: QmdQueryOutcome } => item.ok && Boolean(item.result.warning))
      .map((item) => item.result.warning as string),
    errors: settled.filter((item): item is { ok: false; error: string } => !item.ok).map((item) => item.error),
  };
}
