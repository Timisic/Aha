import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { parseQmdEnvironment } from "./qmd-request";
import { EXCERPT_MAX_BYTES, EXCERPT_MAX_TEXTS, type RerankScore, type ScoreTexts } from "./quick-link-excerpts";

function parseScores(value: unknown, count: number): RerankScore[] {
  if (!value || typeof value !== "object" || !("results" in value) || !Array.isArray(value.results)) throw new Error("Invalid rerank response.");
  const seen = new Set<number>();
  return value.results.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("index" in entry) || !("relevance_score" in entry) ||
      typeof entry.index !== "number" || !Number.isInteger(entry.index) || entry.index < 0 || entry.index >= count || seen.has(entry.index) ||
      typeof entry.relevance_score !== "number" || !Number.isFinite(entry.relevance_score)) throw new Error("Invalid rerank score.");
    seen.add(entry.index);
    return { index: entry.index, score: entry.relevance_score };
  });
}

export function createExcerptReranker(rawEnvironment: string, inherited: NodeJS.ProcessEnv = process.env): ScoreTexts | null {
  const environment = { ...inherited };
  for (const [name, value] of Object.entries(parseQmdEnvironment(rawEnvironment))) if (value) environment[name] = value;
  const endpoint = environment.QMD_REMOTE_RERANK_URL;
  if (!endpoint) return null;
  let url: URL;
  try { url = new URL(endpoint); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return async (query, documents, signal) => {
    signal.throwIfAborted();
    const payload = JSON.stringify({ model: environment.QMD_REMOTE_RERANK_MODEL, query, documents });
    if (documents.length > EXCERPT_MAX_TEXTS || Buffer.byteLength(payload) > EXCERPT_MAX_BYTES) throw new Error("Excerpt request exceeds bounds.");
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
      if (environment.QMD_REMOTE_RERANK_API_KEY) headers.Authorization = `Bearer ${environment.QMD_REMOTE_RERANK_API_KEY}`;
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: "POST", headers });
      let settled = false;
      const finish = (error: Error | null, result: RerankScore[] = []) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (error) { request.destroy(); reject(error); } else resolve(result);
      };
      const abort = () => finish(new Error("Excerpt request cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      request.on("error", (error) => finish(error));
      request.on("response", (response) => {
        if (response.statusCode !== 200) { response.destroy(); finish(new Error("Rerank service unavailable.")); return; }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) { response.destroy(); finish(new Error("Rerank response exceeds bounds.")); return; }
          chunks.push(chunk);
        });
        response.on("error", (error) => finish(error));
        response.on("end", () => {
          try { const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); finish(null, parseScores(body, documents.length)); }
          catch { finish(new Error("Invalid rerank response.")); }
        });
      });
      request.end(payload);
    });
  };
}
