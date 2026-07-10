const RETRY_CATEGORIES = new Set(["http_429", "http_5xx", "timeout", "transport"]);
const TRANSIENT_TRANSPORT_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);

export function emptyOpenAiTransportStats() {
  return {
    request_count: 0,
    attempt_count: 0,
    retry_count: 0,
    retry_categories: {},
  };
}

export function normalizeOpenAiTransportStats(value) {
  const requestCount = transportCount(value, "request_count");
  const attemptCount = transportCount(value, "attempt_count");
  if (attemptCount < requestCount) {
    throw new Error("OpenAI transport attempt_count must be at least request_count.");
  }
  const derivedRetryCount = attemptCount - requestCount;
  const retryCount = Object.hasOwn(value ?? {}, "retry_count")
    ? transportCount(value, "retry_count")
    : derivedRetryCount;
  if (requestCount + retryCount !== attemptCount) {
    throw new Error("OpenAI transport request_count + retry_count must equal attempt_count.");
  }
  return {
    request_count: requestCount,
    attempt_count: attemptCount,
    retry_count: retryCount,
    retry_categories: normalizeRetryCategories(value?.retry_categories, retryCount),
  };
}

export function normalizeOpenAiAttemptFragment(value) {
  const requestCount = transportCount(value, "request_count");
  if (requestCount !== 0) {
    throw new Error("OpenAI attempt fragments cannot declare logical requests.");
  }
  const attemptCount = transportCount(value, "attempt_count");
  const derivedRetryCount = Math.max(0, attemptCount - 1);
  const retryCount = Object.hasOwn(value ?? {}, "retry_count")
    ? transportCount(value, "retry_count")
    : derivedRetryCount;
  if (retryCount !== derivedRetryCount) {
    throw new Error("OpenAI attempt fragment retry_count must equal attempt_count - 1.");
  }
  return {
    request_count: 0,
    attempt_count: attemptCount,
    retry_count: retryCount,
    retry_categories: normalizeRetryCategories(value?.retry_categories, retryCount),
  };
}

export function mergeOpenAiTransportStats(...values) {
  const merged = emptyOpenAiTransportStats();
  for (const value of values) {
    const normalized = normalizeOpenAiTransportStats(value);
    merged.request_count += normalized.request_count;
    merged.attempt_count += normalized.attempt_count;
    merged.retry_count += normalized.retry_count;
    for (const [category, count] of Object.entries(normalized.retry_categories)) {
      merged.retry_categories[category] = (merged.retry_categories[category] ?? 0) + count;
    }
  }
  return merged;
}

function transportCount(value, key) {
  const raw = value?.[key];
  if (raw === undefined || raw === null) return 0;
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`OpenAI transport ${key} must be a non-negative safe integer.`);
  }
  return number;
}

function normalizeRetryCategories(value, retryCount) {
  if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("OpenAI transport retry_categories must be an object.");
  }
  const normalized = {};
  let categoryTotal = 0;
  for (const category of RETRY_CATEGORIES) {
    if (!Object.hasOwn(value ?? {}, category)) continue;
    const count = transportCount(value, category);
    if (count === 0) continue;
    normalized[category] = count;
    categoryTotal += count;
  }
  if (categoryTotal !== retryCount) {
    throw new Error("OpenAI transport retry category total must equal retry_count.");
  }
  return normalized;
}

export function openAiTransportCategory(error) {
  if (RETRY_CATEGORIES.has(error?.openAiRetryCategory)) return error.openAiRetryCategory;
  const codes = [error?.code, error?.nodeErrorCode, error?.cause?.code]
    .map((code) => String(code ?? "").toUpperCase());
  if (codes.includes("ETIMEDOUT") || /timed? out|timeout|curl: \(28\)/i.test(String(error?.message ?? ""))) {
    return "timeout";
  }
  return "transport";
}

export function isRetryableOpenAiTransportError(error) {
  if (typeof error?.openAiRetryable === "boolean") return error.openAiRetryable;
  const codes = [error?.code, error?.nodeErrorCode, error?.cause?.code]
    .map((code) => String(code ?? "").toUpperCase());
  if (codes.some((code) => TRANSIENT_TRANSPORT_CODES.has(code))) return true;
  return /(?:timed? out|timeout|socket hang up|connection (?:reset|refused)|temporary failure|network is unreachable|host is unreachable|curl: \(28\))/i
    .test(String(error?.message ?? ""));
}

export function wrapOpenAiCurlFallbackError(nodeError, curlError) {
  const wrapped = new Error("OpenAI transport failed after Node and curl attempts.");
  wrapped.code = curlError?.code ?? nodeError?.code;
  wrapped.nodeErrorCode = nodeError?.code;
  wrapped.openAiRetryable = isRetryableOpenAiTransportError(curlError)
    || isRetryableOpenAiTransportError(nodeError);
  wrapped.openAiRetryCategory = isRetryableOpenAiTransportError(curlError)
    ? openAiTransportCategory(curlError)
    : openAiTransportCategory(nodeError);
  return wrapped;
}
