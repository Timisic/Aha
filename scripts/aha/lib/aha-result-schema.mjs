import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../aha-result.schema.json");
export const AHA_RESULT_SCHEMA = JSON.parse(readFileSync(schemaPath, "utf8"));
const candidateProperties = AHA_RESULT_SCHEMA.properties.candidates.items.properties;

export const RELATIONS = new Set(candidateProperties.relation.enum);
const STRONG_RELATIONS = new Set(["supports", "challenges", "resembles", "bounds"]);
const HIT_MIN_LENGTH = candidateProperties.hit.minLength ?? 1;
const WHY_MIN_LENGTH = candidateProperties.why.minLength ?? 12;

export function validateAhaResult(value) {
  const errors = [];
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

function validateFailure(error, errors) {
  if (!isObject(error)) {
    errors.push("Failed result must include error object.");
    return;
  }
  for (const field of ["message", "tool", "details"]) {
    if (typeof error[field] !== "string" || error[field].trim().length === 0) {
      errors.push(`Failed result must include error.${field}.`);
    }
  }
}

function validateCandidate(candidate, index, errors) {
  if (!isObject(candidate)) {
    errors.push(`candidates[${index}] must be an object.`);
    return;
  }
  if (typeof candidate.notePath !== "string" || candidate.notePath.trim().length === 0) {
    errors.push(`candidates[${index}].notePath must be a non-empty string.`);
  }
  if (candidate.noteTitle !== undefined && typeof candidate.noteTitle !== "string") {
    errors.push(`candidates[${index}].noteTitle must be a string when present.`);
  }
  if (typeof candidate.relation !== "string" || !RELATIONS.has(candidate.relation)) {
    errors.push(`candidates[${index}].relation is invalid.`);
  }
  if (typeof candidate.hit !== "string" || candidate.hit.trim().length < HIT_MIN_LENGTH) {
    errors.push(`candidates[${index}].hit must be a non-empty string.`);
  }
  if (typeof candidate.why !== "string" || candidate.why.trim().length < WHY_MIN_LENGTH) {
    errors.push(`candidates[${index}].why must be a sufficiently detailed string.`);
  }
  if (STRONG_RELATIONS.has(candidate.relation)) {
    const quotes = Array.isArray(candidate.quotes)
      ? candidate.quotes.filter((quote) => typeof quote === "string" && quote.trim())
      : [];
    if (quotes.length === 0 && !looksQuoteBacked(candidate.hit)) {
      errors.push(`candidates[${index}] strong relation must include quote-backed hit material.`);
    }
  }
  if (candidate.quotes !== undefined && !stringArray(candidate.quotes)) {
    errors.push(`candidates[${index}].quotes must be an array of strings when present.`);
  }
}

function looksQuoteBacked(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return /^["'`“‘]/.test(trimmed) || /["'`”’]$/.test(trimmed) || trimmed.includes("...");
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
