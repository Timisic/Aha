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
