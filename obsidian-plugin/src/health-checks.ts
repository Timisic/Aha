// Settings-page health section (issue #59): four status lights (qmd binary
// detection, index coverage of the current vault, qmd inference endpoints,
// LLM connectivity) plus the explicit embed-button sequencing logic.
//
// Every decision function here is pure and takes already-fetched probe
// results as plain data -- no subprocess spawning, no network calls, no
// Obsidian imports -- so this module is directly unit-testable with fixture
// text blobs and fake spawn results, mirroring how tier-pipeline.ts /
// recall-tier.ts separate pure decision logic from I/O adapters. The actual
// I/O (spawning `qmd status` / `qmd update` / `qmd embed`, the LLM
// connectivity probe) lives in qmd-request.ts / llm-request.ts and is wired
// into these functions only by settings.ts's health-section renderer.

export interface HealthLight {
  id: "qmd-binary" | "index-coverage" | "qmd-endpoints" | "llm-connectivity";
  label: string;
  ok: boolean;
  message: string;
  /** Exact, copyable fix command/string. Present only when ok is false. */
  fixCommand?: string;
}

export interface QmdStatusModels {
  embedding: string | null;
  reranking: string | null;
  generation: string | null;
}

export interface QmdStatusParsed {
  totalIndexed: number | null;
  vectorsEmbedded: number | null;
  updatedAgo: string | null;
  models: QmdStatusModels;
}

/**
 * Parses `qmd status --index <name>`'s text output. Matches the real shape
 * observed from a local run:
 *   Documents
 *     Total:    388 files indexed
 *     Vectors:  594 embedded
 *     Updated:  16d ago
 *   Models
 *     Embedding:  ...
 *     Reranking:  ...
 *     Generation: ...
 * Tolerant of missing sections: any field qmd's own output doesn't include
 * resolves to null rather than throwing, so a future qmd output-format
 * change degrades this to "can't determine" instead of crashing the
 * settings page.
 */
export function parseQmdStatusOutput(text: string): QmdStatusParsed {
  const raw = String(text ?? "");
  const totalMatch = raw.match(/Total:\s*([\d,]+)\s*files indexed/i);
  const vectorsMatch = raw.match(/Vectors:\s*([\d,]+)\s*embedded/i);
  const updatedMatch = raw.match(/Updated:\s*([^\n\r]+)/i);
  const embeddingMatch = raw.match(/Embedding:\s*([^\n\r]+)/i);
  const rerankingMatch = raw.match(/Reranking:\s*([^\n\r]+)/i);
  const generationMatch = raw.match(/Generation:\s*([^\n\r]+)/i);
  return {
    totalIndexed: totalMatch ? Number(totalMatch[1].replace(/,/g, "")) : null,
    vectorsEmbedded: vectorsMatch ? Number(vectorsMatch[1].replace(/,/g, "")) : null,
    updatedAgo: updatedMatch ? updatedMatch[1].trim() : null,
    models: {
      embedding: embeddingMatch ? embeddingMatch[1].trim() : null,
      reranking: rerankingMatch ? rerankingMatch[1].trim() : null,
      generation: generationMatch ? generationMatch[1].trim() : null,
    },
  };
}

const QMD_INSTALL_FIX_COMMAND = "Install qmd and ensure it is on PATH, or set an explicit path in Advanced settings (QMD path override). See https://github.com/tobilu/qmd for install instructions.";

export function decideQmdBinaryLight(available: boolean): HealthLight {
  return available
    ? { id: "qmd-binary", label: "QMD binary", ok: true, message: "qmd is installed and responds to --version." }
    : { id: "qmd-binary", label: "QMD binary", ok: false, message: "qmd did not respond to --version.", fixCommand: QMD_INSTALL_FIX_COMMAND };
}

export interface QmdStatusProbeResult {
  ok: boolean;
  stdout: string;
  message: string;
}

/**
 * Index coverage: compares qmd status's own reported indexed-file count
 * against the vault's real markdown file count (from Obsidian's own API,
 * passed in by the caller -- this function takes the count as a plain
 * number so it needs no Obsidian import). Red on: the status probe itself
 * failing, an unparseable/zero indexed count, or a wide gap against the
 * vault's real file count (more than half the vault missing from the
 * index) -- a reasonable "stale/incomplete index" signal without requiring
 * an exact match (qmd's own indexing legitimately excludes some files).
 */
export function decideIndexCoverageLight(probe: QmdStatusProbeResult | null, vaultMarkdownFileCount: number, qmdIndex: string): HealthLight {
  const fixCommand = `qmd update --index ${qmdIndex}`;
  if (!probe || !probe.ok) {
    return {
      id: "index-coverage",
      label: "Index coverage",
      ok: false,
      message: probe ? `qmd status failed: ${probe.message}` : "qmd status did not run.",
      fixCommand,
    };
  }
  const parsed = parseQmdStatusOutput(probe.stdout);
  if (parsed.totalIndexed === null) {
    return { id: "index-coverage", label: "Index coverage", ok: false, message: "Could not parse an indexed file count from qmd status output.", fixCommand };
  }
  if (parsed.totalIndexed === 0) {
    return { id: "index-coverage", label: "Index coverage", ok: false, message: "qmd reports 0 files indexed.", fixCommand };
  }
  if (vaultMarkdownFileCount > 0 && parsed.totalIndexed < vaultMarkdownFileCount * 0.5) {
    return {
      id: "index-coverage",
      label: "Index coverage",
      ok: false,
      message: `qmd has only ${parsed.totalIndexed} of the vault's ${vaultMarkdownFileCount} markdown files indexed.`,
      fixCommand,
    };
  }
  return {
    id: "index-coverage",
    label: "Index coverage",
    ok: true,
    message: `qmd has ${parsed.totalIndexed} files indexed (vault has ${vaultMarkdownFileCount} markdown files)${parsed.updatedAgo ? `, updated ${parsed.updatedAgo}` : ""}.`,
  };
}

/**
 * QMD inference endpoints: this is an honest, non-network check, not a real
 * reachability probe (probing configured embedding/generation/rerank
 * endpoints would require live network calls in a health-check context,
 * which this module deliberately avoids fabricating). It checks two things
 * that are cheaply and honestly knowable without a network call:
 *   1. every `*_URL` value in the advanced QMD environment field parses as a
 *      syntactically valid URL (a real misconfiguration -- a typo'd URL --
 *      is the single most common way this breaks), and
 *   2. qmd status's own Models section reports configured
 *      embedding/reranking/generation backends (qmd itself already knows
 *      whether its configured inference endpoints are wired up).
 * Green with no environment overrides configured is treated as "using qmd's
 * local/default inference", not silently glossed over -- the message says
 * so explicitly.
 */
export function decideQmdEndpointsLight(qmdEnvironmentEntries: Record<string, string>, probe: QmdStatusProbeResult | null, qmdIndex: string): HealthLight {
  const urlEntries = Object.entries(qmdEnvironmentEntries).filter(([key]) => /_URL$/i.test(key));
  for (const [key, value] of urlEntries) {
    if (!value) continue;
    try {
      // eslint-disable-next-line no-new
      new URL(value);
    } catch {
      return {
        id: "qmd-endpoints",
        label: "QMD inference endpoints",
        ok: false,
        message: `${key} is not a valid URL: ${value}`,
        fixCommand: `Fix the ${key} line in Advanced > QMD environment.`,
      };
    }
  }

  if (!probe || !probe.ok) {
    return {
      id: "qmd-endpoints",
      label: "QMD inference endpoints",
      ok: false,
      message: probe ? `qmd status failed: ${probe.message}` : "qmd status did not run, so configured inference endpoints could not be confirmed.",
      fixCommand: `qmd status --index ${qmdIndex}`,
    };
  }

  const parsed = parseQmdStatusOutput(probe.stdout);
  const hasModelsSection = Boolean(parsed.models.embedding || parsed.models.reranking || parsed.models.generation);
  if (!hasModelsSection) {
    return {
      id: "qmd-endpoints",
      label: "QMD inference endpoints",
      ok: false,
      message: "qmd status did not report a Models section.",
      fixCommand: `qmd status --index ${qmdIndex}`,
    };
  }

  return {
    id: "qmd-endpoints",
    label: "QMD inference endpoints",
    ok: true,
    message: urlEntries.length > 0
      ? `${urlEntries.length} configured endpoint URL(s) are syntactically valid, and qmd status reports configured models.`
      : "No remote endpoint overrides configured; qmd status reports configured local/default models.",
  };
}

export interface LlmConnectivityProbeResult {
  ok: boolean;
  provider: string;
  model: string;
  message: string;
}

export function decideLlmConnectivityLight(probe: LlmConnectivityProbeResult): HealthLight {
  return probe.ok
    ? { id: "llm-connectivity", label: "LLM connectivity", ok: true, message: probe.message }
    : {
        id: "llm-connectivity",
        label: "LLM connectivity",
        ok: false,
        message: probe.message,
        fixCommand: "Check the API key or key-environment variable in the LLM service group above.",
      };
}

// --- Embed button sequencing (issue #59) ------------------------------------
// This must be the ONLY place embedding ever runs, and it must only run from
// the button's own click handler -- never automatically from a health
// check, a search round, or plugin load. Kept pure/injectable (fake
// runUpdate/runEmbed) so sequencing and progress-callback behavior are
// testable without a real qmd binary.

export interface EmbedStepOutcome {
  ok: boolean;
  message: string;
}

export interface EmbedSequenceDeps {
  runUpdate(): Promise<EmbedStepOutcome>;
  runEmbed(): Promise<EmbedStepOutcome>;
}

export type EmbedStepName = "update" | "embed";
export type EmbedStepStatus = "started" | "succeeded" | "failed";

export interface EmbedSequenceStepResult {
  step: EmbedStepName;
  ok: boolean;
  message: string;
}

export interface EmbedSequenceResult {
  ok: boolean;
  steps: EmbedSequenceStepResult[];
}

/**
 * Runs `qmd update --index <name>` then, only if that succeeded,
 * `qmd embed --index <name>` -- the exact two-step sequence
 * docs/obsidian-plugin-operations.md documents, executed as two separate
 * bounded subprocess calls (never a shell `&&`). Reports progress via
 * onProgress before each step starts and after it settles; never calls
 * runEmbed when runUpdate failed.
 */
export async function runEmbedSequence(
  deps: EmbedSequenceDeps,
  onProgress: (step: EmbedStepName, status: EmbedStepStatus, message?: string) => void,
): Promise<EmbedSequenceResult> {
  const steps: EmbedSequenceStepResult[] = [];

  onProgress("update", "started");
  const updateOutcome = await deps.runUpdate();
  steps.push({ step: "update", ok: updateOutcome.ok, message: updateOutcome.message });
  onProgress("update", updateOutcome.ok ? "succeeded" : "failed", updateOutcome.message);
  if (!updateOutcome.ok) {
    return { ok: false, steps };
  }

  onProgress("embed", "started");
  const embedOutcome = await deps.runEmbed();
  steps.push({ step: "embed", ok: embedOutcome.ok, message: embedOutcome.message });
  onProgress("embed", embedOutcome.ok ? "succeeded" : "failed", embedOutcome.message);
  return { ok: embedOutcome.ok, steps };
}
