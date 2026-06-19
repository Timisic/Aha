export interface CanonicalNoteIdentity {
  canonicalPath: string;
  canonicalId: string;
  title: string;
  aliases: string[];
}

export type NoteIdentityResolution =
  | ({ status: "resolved" } & CanonicalNoteIdentity)
  | { status: "ambiguous"; input: string; matches: CanonicalNoteIdentity[] }
  | { status: "unresolved"; input: string; normalizedHint: string };

export interface NoteIdentityResolver {
  root: string;
  files: string[];
  byRelative: Map<string, string[]>;
  bySlug: Map<string, string[]>;
  byBasename: Map<string, string[]>;
  byTitle: Map<string, string[]>;
  byAlias: Map<string, string[]>;
  identities: Map<string, CanonicalNoteIdentity>;
}

export function stripPathDecorations(path: string | undefined): string;
export function slugPath(path: string | undefined): string;
export function buildNoteIdentityResolver(root: string): NoteIdentityResolver;
export function resolveNoteIdentity(input: string | undefined, resolver: NoteIdentityResolver): NoteIdentityResolution;
export function equivalentNoteIdentity(a: string | undefined, b: string | undefined, resolver: NoteIdentityResolver): boolean;
export function deterministicFallbackCanonicalId(input: { collection?: string; path?: string; slug?: string; title?: string; content?: string; queryText?: string }): string;
export function normalizeIdentityHint(input: string | undefined): string;
