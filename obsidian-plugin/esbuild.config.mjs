import esbuild from "esbuild";

const prod = process.argv[2] === "production";

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
