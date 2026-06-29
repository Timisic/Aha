import ahaResultSchema from "../../scripts/aha/aha-result.schema.json";

const FALLBACK_RELATIONS = ["supports", "challenges", "resembles", "bounds", "weak"] as const;
export const RELATIONS = relationValuesFromSchema(ahaResultSchema);

export type AhaRelation = (typeof RELATIONS)[number];

export interface AhaCandidate {
  notePath: string;
  noteTitle?: string;
  relation: AhaRelation;
  hit: string;
  why: string;
  quotes?: string[];
  selected?: boolean;
}

export interface AhaWrapperFailure {
  message: string;
  tool?: string;
  details?: string;
}

export interface AhaWrapperResult {
  ok: boolean;
  sourcePath?: string;
  generatedAt?: string;
  summary?: string;
  candidates?: AhaCandidate[];
  warnings?: string[];
  error?: AhaWrapperFailure;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  result?: AhaWrapperResult;
}

const STRONG_RELATIONS = new Set<AhaRelation>(["supports", "challenges", "resembles", "bounds"]);
const HIT_MIN_LENGTH = candidateStringMinLength(ahaResultSchema, "hit", 1);
const WHY_MIN_LENGTH = candidateStringMinLength(ahaResultSchema, "why", 12);

export function validateAhaWrapperResult(value: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(value)) {
    return { ok: false, errors: ["Wrapper output must be a JSON object."] };
  }

  if (typeof value.ok !== "boolean") {
    errors.push("Wrapper output must include boolean ok.");
  }

  if (value.ok === false) {
    validateFailure(value.error, errors);
  }

  if (value.ok === true) {
    if (!Array.isArray(value.candidates)) {
      errors.push("Successful wrapper output must include candidates array.");
    } else {
      value.candidates.forEach((candidate, index) => validateCandidate(candidate, index, errors));
    }
  }

  if (value.warnings !== undefined && !isStringArray(value.warnings)) {
    errors.push("warnings must be an array of strings.");
  }

  return errors.length === 0
    ? { ok: true, errors, result: value as unknown as AhaWrapperResult }
    : { ok: false, errors };
}

function validateFailure(error: unknown, errors: string[]): void {
  if (!isRecord(error)) {
    errors.push("Failed wrapper output must include error object.");
    return;
  }
  for (const field of ["message", "tool", "details"] as const) {
    if (typeof error[field] !== "string" || error[field].trim().length === 0) {
      errors.push(`Failed wrapper output must include error.${field}.`);
    }
  }
}

function validateCandidate(value: unknown, index: number, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`candidates[${index}] must be an object.`);
    return;
  }

  if (typeof value.notePath !== "string" || value.notePath.trim().length === 0) {
    errors.push(`candidates[${index}].notePath must be a non-empty string.`);
  }

  if (value.noteTitle !== undefined && typeof value.noteTitle !== "string") {
    errors.push(`candidates[${index}].noteTitle must be a string when present.`);
  }

  if (!isRelation(value.relation)) {
    errors.push(`candidates[${index}].relation must be one of ${RELATIONS.join(", ")}.`);
  }

  if (typeof value.hit !== "string" || value.hit.trim().length < HIT_MIN_LENGTH) {
    errors.push(`candidates[${index}].hit must be a non-empty string.`);
  }

  if (typeof value.why !== "string" || value.why.trim().length < WHY_MIN_LENGTH) {
    errors.push(`candidates[${index}].why must be a sufficiently detailed string.`);
  }

  if (isRelation(value.relation) && STRONG_RELATIONS.has(value.relation)) {
    const quotes = Array.isArray(value.quotes) ? value.quotes.filter((quote) => typeof quote === "string" && quote.trim()) : [];
    if (quotes.length === 0 && !looksQuoteBacked(value.hit)) {
      errors.push(`candidates[${index}] strong relation must include quote-backed hit material.`);
    }
  }

  if (value.quotes !== undefined && !isStringArray(value.quotes)) {
    errors.push(`candidates[${index}].quotes must be an array of strings when present.`);
  }
}

function isRelation(value: unknown): value is AhaRelation {
  return typeof value === "string" && (RELATIONS as readonly string[]).includes(value);
}

function looksQuoteBacked(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return /^["'`“‘]/.test(trimmed) || /["'`”’]$/.test(trimmed) || trimmed.includes("...");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relationValuesFromSchema(schema: unknown): typeof FALLBACK_RELATIONS {
  const relation = candidateProperty(schema, "relation");
  const values = isRecord(relation) && Array.isArray(relation.enum)
    ? relation.enum.filter((item): item is string => typeof item === "string")
    : [];
  return values.length > 0 ? values as unknown as typeof FALLBACK_RELATIONS : FALLBACK_RELATIONS;
}

function candidateStringMinLength(schema: unknown, propertyName: string, fallback: number): number {
  const property = candidateProperty(schema, propertyName);
  const minLength = isRecord(property) ? property.minLength : undefined;
  return typeof minLength === "number" ? minLength : fallback;
}

function candidateProperty(schema: unknown, propertyName: string): unknown {
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;
  const candidates = schema.properties.candidates;
  if (!isRecord(candidates) || !isRecord(candidates.items) || !isRecord(candidates.items.properties)) return undefined;
  return candidates.items.properties[propertyName];
}
