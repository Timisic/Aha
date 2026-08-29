// Entry point for the session-store Node artifact (batch vault runner,
// BATCH-VAULT-RUNNER-PLAN.md). esbuild compiles this into
// obsidian-plugin/dist/session.mjs so a Node CLI can write AhaSessionRecord
// rounds into the same data.json shape the plugin itself writes, using the
// exact same logic -- never a reimplementation. Keep everything reachable
// from here free of `obsidian` runtime imports (type-only imports of
// `obsidian` types are fine; esbuild elides them).

export * from "./session-store";
export * from "./source-identity";
