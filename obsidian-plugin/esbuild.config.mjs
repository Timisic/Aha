import esbuild from "esbuild";

const mode = process.argv[2] ?? "";

if (mode === "core") {
  // Standalone shared-core artifact (ADR 0005). Not committed; bench/verify
  // entry points rebuild it before importing.
  await esbuild.build({
    banner: {
      js: "/* Aha shared core artifact. Generated from src/core/index.ts. Do not commit. */",
    },
    bundle: true,
    entryPoints: ["src/core/index.ts"],
    format: "esm",
    logLevel: "info",
    minify: false,
    outfile: "dist/core.mjs",
    platform: "neutral",
    sourcemap: false,
    target: "es2022",
    treeShaking: true,
  });
} else if (mode === "session") {
  // Standalone session-store Node artifact (BATCH-VAULT-RUNNER-PLAN.md). Not
  // committed; the batch vault runner rebuilds it before importing, same as
  // the "core" target above.
  await esbuild.build({
    banner: {
      js: "/* Aha session-store artifact. Generated from src/session-index.ts. Do not commit. */",
    },
    bundle: true,
    entryPoints: ["src/session-index.ts"],
    // Unlike the "core" target, this dependency graph is not Node-free:
    // source-identity.ts hashes note identity with node:crypto and
    // node:fs/promises (same builtins the main plugin bundle below
    // externalizes). platform: "node" + external resolves those as bare
    // Node specifiers at import time; no obsidian alias/stub plugin is
    // needed since the only "obsidian" reference (source-identity.ts's
    // `import type { TFile }`) is type-only and esbuild elides it.
    external: ["crypto", "fs/promises"],
    format: "esm",
    logLevel: "info",
    minify: false,
    outfile: "dist/session.mjs",
    platform: "node",
    sourcemap: false,
    target: "es2022",
    treeShaking: true,
  });
} else {
  const prod = mode === "production";

  await esbuild.build({
    banner: {
      js: "/* Aha Obsidian plugin. Generated from src/main.ts. */",
    },
    bundle: true,
    entryPoints: ["src/main.ts"],
    external: [
      "obsidian",
      "electron",
      "child_process",
      "crypto",
      "fs",
      "fs/promises",
      "path",
      "os",
      "process",
    ],
    format: "cjs",
    logLevel: "info",
    minify: prod,
    outfile: "main.js",
    platform: "node",
    sourcemap: prod ? false : "inline",
    target: "es2022",
    treeShaking: true,
  });
}
