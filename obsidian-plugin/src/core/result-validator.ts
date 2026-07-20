// Shared Aha result validation (ADR 0005, issue #57). Verbatim port of
// scripts/aha/lib/result-validator.mjs's validateAhaResult and its helpers.
//
// The schema is embedded as a TS literal rather than imported from
// scripts/aha/aha-result.schema.json: this file must stay free of node
// imports (no fs/path/import.meta.url), and a JSON import that reaches out of
// obsidian-plugin/ into scripts/ would tie the core-mode esbuild build (this
// module's compiled artifact is also the standalone bench build) to a
// cross-package path. The single-source-of-truth risk this creates (the
// literal and the JSON file silently drifting) is covered by a dedicated test
// (core-result-validator.test.mjs) that deep-equals this literal against
// JSON.parse(readFileSync(aha-result.schema.json)) on every test run.
//
// This module must stay free of `obsidian` imports, node imports, and
// module-level I/O.

export const AHA_RESULT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["ok", "sourcePath", "generatedAt", "summary", "warnings", "error", "candidates"],
  properties: {
    ok: { type: "boolean" },
    sourcePath: { type: ["string", "null"] },
    generatedAt: { type: ["string", "null"] },
    summary: { type: ["string", "null"] },
    warnings: {
      type: ["array", "null"],
      items: { type: "string" },
    },
    error: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["message", "tool", "details"],
      properties: {
        message: { type: ["string", "null"] },
        tool: { type: ["string", "null"] },
        details: { type: ["string", "null"] },
      },
    },
    candidates: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["notePath", "noteTitle", "relation", "hit", "why", "quotes", "selected"],
        properties: {
          notePath: { type: "string", minLength: 1 },
          noteTitle: { type: ["string", "null"] },
          relation: {
            type: "string",
            enum: ["supports", "challenges", "resembles", "bounds", "weak"],
          },
          hit: { type: "string", minLength: 1 },
          why: { type: "string", minLength: 12 },
          quotes: {
            type: ["array", "null"],
            items: { type: "string" },
          },
          selected: { type: ["boolean", "null"] },
        },
      },
    },
  },
} as const;

const candidateProperties = AHA_RESULT_SCHEMA.properties.candidates.items.properties;

export const RELATIONS: ReadonlySet<string> = new Set(candidateProperties.relation.enum);
const STRONG_RELATIONS = new Set(["supports", "challenges", "resembles", "bounds"]);
const HIT_MIN_LENGTH = candidateProperties.hit.minLength ?? 1;
const WHY_MIN_LENGTH = candidateProperties.why.minLength ?? 12;

export interface AhaResultValidation {
  ok: boolean;
  errors: string[];
}

export function validateAhaResult(value: unknown): AhaResultValidation {
  const errors: string[] = [];
  if (!isObject(value)) {
    return { ok: false, errors: ["Result must be a JSON object."] };
  }

  if (typeof value.ok !== "boolean") {
    errors.push("Result must include boolean ok.");
  }

  if (value.ok === false) {
    validateFailure(value.error, errors);
  }

  if (value.ok === true) {
    if (!Array.isArray(value.candidates)) {
      errors.push("Successful result must include candidates array.");
    } else {
      value.candidates.forEach((candidate, index) => validateCandidate(candidate, index, errors));
    }
  }

  if (value.warnings !== undefined && !stringArray(value.warnings)) {
    errors.push("warnings must be an array of strings.");
  }

  return { ok: errors.length === 0, errors };
}

function validateFailure(error: unknown, errors: string[]): void {
  if (!isObject(error)) {
    errors.push("Failed result must include error object.");
    return;
  }
  for (const field of ["message", "tool", "details"]) {
    const fieldValue = (error as Record<string, unknown>)[field];
    if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
      errors.push(`Failed result must include error.${field}.`);
    }
  }
}

function validateCandidate(candidate: unknown, index: number, errors: string[]): void {
  if (!isObject(candidate)) {
    errors.push(`candidates[${index}] must be an object.`);
    return;
  }
  const record = candidate as Record<string, unknown>;
  if (typeof record.notePath !== "string" || record.notePath.trim().length === 0) {
    errors.push(`candidates[${index}].notePath must be a non-empty string.`);
  }
  if (record.noteTitle !== undefined && typeof record.noteTitle !== "string") {
    errors.push(`candidates[${index}].noteTitle must be a string when present.`);
  }
  if (typeof record.relation !== "string" || !RELATIONS.has(record.relation)) {
    errors.push(`candidates[${index}].relation is invalid.`);
  }
  if (typeof record.hit !== "string" || record.hit.trim().length < HIT_MIN_LENGTH) {
    errors.push(`candidates[${index}].hit must be a non-empty string.`);
  }
  if (typeof record.why !== "string" || record.why.trim().length < WHY_MIN_LENGTH) {
    errors.push(`candidates[${index}].why must be a sufficiently detailed string.`);
  }
  if (STRONG_RELATIONS.has(record.relation as string)) {
    const quotes = Array.isArray(record.quotes)
      ? record.quotes.filter((quote): quote is string => typeof quote === "string" && quote.trim().length > 0)
      : [];
    if (quotes.length === 0 && !looksQuoteBacked(record.hit)) {
      errors.push(`candidates[${index}] strong relation must include quote-backed hit material.`);
    }
  }
  if (record.quotes !== undefined && !stringArray(record.quotes)) {
    errors.push(`candidates[${index}].quotes must be an array of strings when present.`);
  }
}

function looksQuoteBacked(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return /^["'`“‘]/.test(trimmed) || /["'`”’]$/.test(trimmed) || trimmed.includes("...");
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
