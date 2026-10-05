import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildArtifact } from "../../../../obsidian-plugin/build-artifact.mjs";

test("concurrent builds publish complete modules without replacing the last good artifact mid-build", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aha-publication-"));
  const outfile = path.join(directory, "core.mjs");
  const firstReady = Promise.withResolvers();
  const secondReady = Promise.withResolvers();
  const releaseFirst = Promise.withResolvers();
  const releaseSecond = Promise.withResolvers();
  const builds = [];
  const options = (value, ready, release) => ({
    stdin: { contents: `export const value = ${JSON.stringify(value)};` },
    format: "esm",
    outfile,
    plugins: [{
      name: "hold-completed-build",
      setup(build) {
        build.onEnd(async () => {
          ready.resolve(build.initialOptions.outfile);
          await release.promise;
        });
      },
    }],
  });
  try {
    await writeFile(outfile, 'export const value = "previous";\n');
    builds.push(buildArtifact(options("first", firstReady, releaseFirst)));
    builds.push(buildArtifact(options("second", secondReady, releaseSecond)));
    const staged = await Promise.all([firstReady.promise, secondReady.promise]);
    assert.equal((await import(`${pathToFileURL(outfile)}?before`)).value, "previous");
    assert.notEqual(staged[0], staged[1]);
    assert.match(await readFile(staged[0], "utf8"), /first/);
    assert.match(await readFile(staged[1], "utf8"), /second/);

    releaseFirst.resolve();
    await builds[0];
    assert.equal((await import(`${pathToFileURL(outfile)}?first`)).value, "first");
    assert.match(await readFile(staged[1], "utf8"), /second/);

    releaseSecond.resolve();
    await builds[1];
    assert.equal((await import(`${pathToFileURL(outfile)}?second`)).value, "second");
    assert.deepEqual(await readdir(directory), ["core.mjs"]);
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
    await Promise.allSettled(builds);
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed artifact builds preserve the published module and remove their scratch output", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aha-publication-failure-"));
  const outfile = path.join(directory, "session.mjs");
  try {
    await writeFile(outfile, 'export const value = "previous";\n');
    await assert.rejects(buildArtifact({
      stdin: { contents: "export const = invalid;" },
      format: "esm",
      outfile,
      logLevel: "silent",
    }), /Build failed/);
    assert.equal((await import(pathToFileURL(outfile))).value, "previous");
    assert.deepEqual(await readdir(directory), ["session.mjs"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
