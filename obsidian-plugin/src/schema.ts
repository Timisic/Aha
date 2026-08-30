import { AHA_RESULT_SCHEMA, validateAhaResult } from "./core";

// Sourced from core's AHA_RESULT_SCHEMA (ADR 0005) rather than importing
// scripts/aha/aha-result.schema.json directly: that JSON file lives outside
// obsidian-plugin/, and importing it here would give the plugin bundle a
// cross-package dependency back into scripts/, the one direction ADR 0005's
// dependency graph forbids (core compiles -> core-artifact re-export ->
// bench/test, never the reverse). scripts/aha/aha-result.schema.json remains
// bench's source-of-truth JSON file; core/result-validator.ts's guard test
// keeps the two in sync.
export const RELATIONS = AHA_RESULT_SCHEMA.properties.candidates.items.properties.relation.enum;

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
  trace?: AhaTraceReference;
  ok: boolean;
  sourcePath?: string;
  generatedAt?: string;
  summary?: string;
  candidates?: AhaCandidate[];
  warnings?: string[];
  error?: AhaWrapperFailure;
}

/** Compact locator only; prompts and retrieval details stay outside data.json. */
export interface AhaTraceReference {
  path: string;
  origin: "plugin" | "batch";
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
