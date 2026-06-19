import { pathToFileURL } from "node:url";
import type { Type as TypeboxType } from "typebox";

async function importPackageOrPath<T>(packageName: string, explicitPath: string | undefined, exportName: string): Promise<T> {
  try {
    const module = await import(packageName) as Record<string, unknown>;
    const value = module[exportName];
    if (value) return value as T;
  } catch (packageError) {
    if (!explicitPath?.trim()) {
      throw new Error(
        `Unable to import ${packageName}. Run npm ci in insight-package, install the Pi package dependencies, or set the explicit path override. Cause: ${packageError instanceof Error ? packageError.message : String(packageError)}`,
      );
    }
  }

  const path = explicitPath?.trim();
  if (!path) throw new Error(`No explicit path override provided for ${packageName}`);
  const module = await import(pathToFileURL(path).href) as Record<string, unknown>;
  const value = module[exportName];
  if (!value) throw new Error(`Expected export ${exportName} from ${explicitPath}`);
  return value as T;
}

export const Type = await importPackageOrPath<TypeboxType>("typebox", process.env.PI_TYPEBOX_PATH, "Type");

const piTui = await import("@earendil-works/pi-tui").catch(async (error) => {
  const explicit = process.env.PI_TUI_PATH?.trim();
  if (!explicit) {
    throw new Error(
      `Unable to import @earendil-works/pi-tui. Run npm ci in insight-package, install the Pi package dependencies, or set PI_TUI_PATH. Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return import(pathToFileURL(explicit).href);
});

export const { truncateToWidth, visibleWidth } = piTui as {
  truncateToWidth: (text: string, maxWidth: number, ellipsis?: string, pad?: boolean) => string;
  visibleWidth: (text: string) => number;
};
