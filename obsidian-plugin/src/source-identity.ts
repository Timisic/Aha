import { createHash } from "crypto";
import { stat } from "fs/promises";
import type { TFile } from "obsidian";

export interface SourceFilesystemIdentity {
  birthtimeMs?: number;
  dev: number;
  ino: number;
}

export function sourceIdentity(file: TFile, filesystem?: SourceFilesystemIdentity): string {
  if (filesystemIdentityIsUsable(filesystem)) {
    return `srcfs:${stableHashToken([
      "aha-source-v3",
      String(filesystem.dev),
      String(filesystem.ino),
      String(Math.trunc(filesystem.birthtimeMs ?? 0)),
    ].join("\0"))}`;
  }

  return `src:${stableHashToken(["aha-source-v2", String(file.stat.ctime)].join("\0"))}`;
}

export async function sourceIdentityForFile(file: TFile, absolutePath: string): Promise<string> {
  try {
    const metadata = await stat(absolutePath);
    return sourceIdentity(file, {
      birthtimeMs: metadata.birthtimeMs,
      dev: metadata.dev,
      ino: metadata.ino,
    });
  } catch {
    return sourceIdentity(file);
  }
}

export function sourceIdentityAllowsPathDrift(sourceId: string): boolean {
  return sourceId.startsWith("srcfs:");
}

export function legacySourceIdentity(path: string): string {
  return `path:${path}`;
}

export function sourceReviewIndexKey(sourceId: string, sourcePath: string): string {
  return `${sourceId}\0${sourcePath}`;
}

function stableHashToken(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 24);
}

function filesystemIdentityIsUsable(filesystem: SourceFilesystemIdentity | undefined): filesystem is SourceFilesystemIdentity {
  return Boolean(
    filesystem
      && Number.isFinite(filesystem.dev)
      && Number.isFinite(filesystem.ino)
      && filesystem.ino > 0,
  );
}
