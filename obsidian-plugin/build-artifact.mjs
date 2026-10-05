import esbuild from "esbuild";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export async function buildArtifact(options) {
  const outfile = resolve(options.absWorkingDir ?? process.cwd(), options.outfile);
  await mkdir(dirname(outfile), { recursive: true });
  const temporary = await mkdtemp(join(dirname(outfile), `.${basename(outfile)}-`));
  try {
    const staged = join(temporary, basename(outfile));
    await esbuild.build({ ...options, outfile: staged });
    await rename(staged, outfile);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
