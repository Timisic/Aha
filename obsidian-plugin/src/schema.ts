import ahaResultSchema from "../../scripts/aha/aha-result.schema.json";
import { validateAhaResult } from "../../scripts/aha/lib/result-validator.mjs";

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

export function validateAhaWrapperResult(value: unknown): ValidationResult {
  const validation = validateAhaResult(value);
  return validation.ok
    ? { ok: true, errors: [], result: value as unknown as AhaWrapperResult }
    : validation;
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

function candidateProperty(schema: unknown, propertyName: string): unknown {
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;
  const candidates = schema.properties.candidates;
  if (!isRecord(candidates) || !isRecord(candidates.items) || !isRecord(candidates.items.properties)) return undefined;
  return candidates.items.properties[propertyName];
}
