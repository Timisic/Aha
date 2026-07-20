// Entry point for the shared core artifact (ADR 0005). esbuild compiles this
// into obsidian-plugin/dist/core.mjs for bench scripts, and the same sources
// bundle into the plugin. Keep everything re-exported here free of `obsidian`
// imports, node imports, and module-level I/O.

export * from "./note-identity";
