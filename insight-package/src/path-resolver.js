export {
  deterministicFallbackCanonicalId,
  equivalentNoteIdentity as equivalentVaultPath,
  normalizeIdentityHint,
  resolveNoteIdentity,
  slugPath,
  stripPathDecorations,
} from "./note-identity.js";

import { buildNoteIdentityResolver, resolveNoteIdentity } from "./note-identity.js";

export function buildVaultPathResolver(root) {
  return buildNoteIdentityResolver(root);
}

export function resolveVaultPath(rawPath, resolver) {
  const resolved = resolveNoteIdentity(rawPath, resolver);
  if (resolved.status === "resolved") {
    return { status: "resolved", path: resolved.canonicalPath, matches: [resolved.canonicalPath] };
  }
  if (resolved.status === "ambiguous") {
    return { status: "ambiguous", matches: resolved.matches.map((match) => match.canonicalPath) };
  }
  return { status: "not_found", matches: [] };
}
