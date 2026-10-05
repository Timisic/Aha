#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { realTestConfig } from "../lib/real-test-config.mjs";

await realTestConfig(process.env);
const directory = path.resolve(import.meta.dirname, "../aha/tests/e2e");
const files = (await readdir(directory)).filter(name => name.endsWith(".test.mjs")).sort().map(name => path.join(directory, name));
const child = spawn(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: { ...process.env, AHA_RUN_REAL_E2E: "1" },
});
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
