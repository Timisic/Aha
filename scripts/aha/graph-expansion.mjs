/**
 * Expand the source note and strongest retrieval seeds by one bounded graph hop.
 * Candidate admission owns vault/exclusion/self-hit rules; this module owns graph
 * traversal budgets, canonical deduplication, provenance, and command failures.
 */
export async function expandGraphCandidates({
  sourcePath,
  rankedSeeds = [],
  policy = {},
  adapters = {},
}) {
  const config = normalizePolicy(policy);
  if (!config.enabled) return emptyResult(config);
  if (typeof adapters.admitCandidate !== "function") {
    throw new TypeError("adapters.admitCandidate must be a function.");
  }
  if (typeof adapters.canonicalIdentity !== "function") {
    throw new TypeError("adapters.canonicalIdentity must be a function.");
  }

  const origins = [];
  if (sourcePath) origins.push({ origin: "source", path: sourcePath, seedRank: null });
  for (const [index, seed] of rankedSeeds.slice(0, config.seedLimit).entries()) {
    const seedPath = candidatePath(seed);
    if (seedPath) origins.push({ origin: "seed", path: seedPath, seedRank: index + 1 });
  }

  const candidates = [];
  const failures = [];
  const byIdentity = new Map();

  for (const origin of origins) {
    if (candidates.length >= config.globalCandidateLimit) break;
    let originCount = 0;
    for (const command of ["links", "backlinks"]) {
      if (candidates.length >= config.globalCandidateLimit || originCount >= config.perOriginLimit) break;
      const commandLimit = command === "links" ? config.linksLimit : config.backlinksLimit;
      if (commandLimit === 0 || typeof adapters[command] !== "function") continue;

      let rows;
      try {
        const response = await adapters[command]({
          path: origin.path,
          limit: commandLimit,
          origin: origin.origin,
          seedRank: origin.seedRank,
        });
        if (response?.ok === false) throw response.error ?? new Error(`${command} failed`);
        rows = Array.isArray(response) ? response : response?.rows ?? response?.candidates ?? [];
      } catch (error) {
        failures.push(commandFailure(command, origin, error));
        continue;
      }

      for (const row of rows.slice(0, commandLimit)) {
        if (candidates.length >= config.globalCandidateLimit || originCount >= config.perOriginLimit) break;
        let admitted;
        try {
          admitted = await adapters.admitCandidate(row, {
            sourcePath,
            fromPath: origin.path,
            origin: origin.origin,
            seedRank: origin.seedRank,
            command,
          });
        } catch (error) {
          failures.push(commandFailure("admission", origin, error, command));
          continue;
        }
        if (!admitted) continue;
        const identity = adapters.canonicalIdentity(admitted);
        if (!identity) continue;

        const evidence = graphEvidence(command, origin);
        const existing = byIdentity.get(identity);
        if (existing) {
          if (!existing.graphEvidence.some((item) => sameEvidence(item, evidence))) {
            existing.graphEvidence.push(evidence);
          }
          continue;
        }

        const candidate = { ...admitted, graphEvidence: [evidence] };
        byIdentity.set(identity, candidate);
        candidates.push(candidate);
        originCount += 1;
      }
    }
  }

  return {
    mode: "source-and-top-seeds",
    enabled: true,
    candidates,
    failures,
    seeds: origins.filter(({ origin }) => origin === "seed").map(({ path, seedRank }) => ({ path, rank: seedRank })),
    policy: config,
  };
}

function normalizePolicy(policy) {
  const graph = policy.graphExpansion && typeof policy.graphExpansion === "object"
    ? policy.graphExpansion
    : policy;
  return {
    enabled: policy.graphExpansion !== false && graph.enabled !== false,
    seedLimit: integerBudget(graph.seedLimit, 0),
    linksLimit: integerBudget(graph.linksLimit, 5),
    backlinksLimit: integerBudget(graph.backlinksLimit, 5),
    perOriginLimit: integerBudget(graph.perSeedLimit ?? graph.perOriginLimit, 8),
    globalCandidateLimit: integerBudget(graph.globalCandidateLimit, 20),
  };
}

function integerBudget(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function candidatePath(candidate) {
  if (typeof candidate === "string") return candidate;
  return candidate?.path ?? candidate?.file ?? null;
}

function graphEvidence(command, origin) {
  return {
    kind: command === "links" ? "outlink" : "backlink",
    origin: origin.origin,
    from: origin.path,
    seedRank: origin.seedRank,
  };
}

function sameEvidence(left, right) {
  return left.kind === right.kind
    && left.origin === right.origin
    && left.from === right.from
    && left.seedRank === right.seedRank;
}

function commandFailure(command, origin, error, graphCommand = command) {
  return {
    stage: "graph_expansion",
    command,
    graphCommand,
    origin: origin.origin,
    from: origin.path,
    seedRank: origin.seedRank,
    message: error instanceof Error ? error.message : String(error),
  };
}

function emptyResult(config) {
  return {
    mode: "disabled",
    enabled: false,
    candidates: [],
    failures: [],
    seeds: [],
    policy: config,
  };
}
