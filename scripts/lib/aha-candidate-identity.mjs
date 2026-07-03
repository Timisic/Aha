export function candidatePath(candidate) {
  return candidate?.file || candidate?.path || candidate?.slug || candidate?.title || "";
}

export function candidateSourceList(candidate) {
  if (Array.isArray(candidate?.sources) && candidate.sources.length > 0) return candidate.sources;
  return candidate?.source ? [candidate.source] : [];
}

export function candidateSourceLabel(candidate) {
  const sources = candidateSourceList(candidate);
  return sources.length > 0 ? sources.join("+") : candidate?.source;
}

export function candidateRerankId(index) {
  return `c${String(index + 1).padStart(3, "0")}`;
}

export function annotateCandidateRerankIds(candidates) {
  return candidates.map((candidate, index) => ({
    ...candidate,
    rerankId: candidateRerankId(index),
  }));
}
