import type { CanonicalNoteIdentity, NoteIdentityResolution, NoteIdentityResolver } from "./note-identity.js";

export interface VaultPathResolver extends NoteIdentityResolver {}

export interface VaultPathResolution {
  status: "resolved" | "ambiguous" | "not_found";
  path?: string;
  matches: string[];
}

export function stripPathDecorations(path: string | undefined): string;
export function slugPath(path: string | undefined): string;
export function buildVaultPathResolver(root: string): VaultPathResolver;
export function resolveVaultPath(rawPath: string | undefined, resolver: VaultPathResolver): VaultPathResolution;
export function equivalentVaultPath(a: string | undefined, b: string | undefined, resolver: VaultPathResolver): boolean;
export function resolveNoteIdentity(input: string | undefined, resolver: VaultPathResolver): NoteIdentityResolution;
export function deterministicFallbackCanonicalId(input: { collection?: string; path?: string; slug?: string; title?: string; content?: string; queryText?: string }): string;
export function normalizeIdentityHint(input: string | undefined): string;
export type { CanonicalNoteIdentity, NoteIdentityResolution };
