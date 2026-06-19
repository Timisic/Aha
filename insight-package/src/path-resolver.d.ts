export interface VaultPathResolver {
  root: string;
  files: string[];
  byRelative: Map<string, string[]>;
  bySlug: Map<string, string[]>;
  byBasename: Map<string, string[]>;
}

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
