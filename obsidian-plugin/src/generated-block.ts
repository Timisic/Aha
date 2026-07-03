export interface GeneratedBlockBody {
  start: number;
  end: number;
  value: string;
}

export interface GeneratedRoundSection {
  generatedAt: string;
  text: string;
  start: number;
  end: number;
}

export function replaceGeneratedBlock(content: string, blockName: string, heading: string, block: string): string {
  const withMarkers = contentHasGeneratedBlock(content, blockName) ? content : ensureGeneratedBlock(content, blockName, heading);
  const startMarker = generatedBlockMarker(blockName, "start");
  const endMarker = generatedBlockMarker(blockName, "end");
  const startIndex = withMarkers.indexOf(startMarker);
  const endIndex = withMarkers.indexOf(endMarker);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return appendToSection(withMarkers, heading, block);
  const bodyStart = startIndex + startMarker.length;
  const before = withMarkers.slice(0, bodyStart).trimEnd();
  const after = withMarkers.slice(endIndex);
  return `${before}\n${block.trim()}\n${after}`;
}

export function ensureGeneratedBlock(content: string, blockName: string, heading: string): string {
  const startMarker = generatedBlockMarker(blockName, "start");
  const endMarker = generatedBlockMarker(blockName, "end");
  if (content.includes(startMarker) && content.includes(endMarker)) return content;
  return appendToSection(content, heading, `${startMarker}\n${endMarker}`);
}

export function contentHasGeneratedBlock(content: string, blockName: string): boolean {
  return content.includes(generatedBlockMarker(blockName, "start")) && content.includes(generatedBlockMarker(blockName, "end"));
}

export function generatedBlockBody(content: string, blockName: string): GeneratedBlockBody | null {
  const startMarker = generatedBlockMarker(blockName, "start");
  const endMarker = generatedBlockMarker(blockName, "end");
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return null;
  const start = startIndex + startMarker.length;
  return {
    start,
    end: endIndex,
    value: content.slice(start, endIndex),
  };
}

export function latestRoundSectionInGeneratedBlock(content: string, blockName: string, headings: string[]): GeneratedRoundSection | null {
  const body = generatedBlockBody(content, blockName);
  if (!body) return null;
  const headingPattern = headings.map(escapeRegExp).join("|");
  const pattern = new RegExp(`(^|\\n)### (${headingPattern}) - ([^\\n]+)`, "g");
  let latest: { start: number; generatedAt: string } | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body.value)) !== null) {
    latest = {
      start: match.index + (match[1] === "\n" ? 1 : 0),
      generatedAt: match[3].trim(),
    };
  }
  if (!latest) return null;
  const nextHeading = body.value.slice(latest.start + 1).search(/\n### /);
  const end = nextHeading === -1 ? body.value.length : latest.start + 1 + nextHeading;
  return {
    generatedAt: latest.generatedAt,
    text: body.value.slice(latest.start, end).trim(),
    start: body.start + latest.start,
    end: body.start + end,
  };
}

function generatedBlockMarker(blockName: string, boundary: "start" | "end"): string {
  return `<!-- aha:${blockName}:${boundary} -->`;
}

function appendToSection(content: string, heading: string, block: string): string {
  const marker = `## ${heading}`;
  const sectionPattern = new RegExp(`(^|\\n)## ${escapeRegExp(heading)}\\n`, "m");
  const match = sectionPattern.exec(content);
  if (!match || match.index === undefined) {
    return `${content.trimEnd()}\n\n${marker}\n\n${block.trim()}\n`;
  }

  const headingStart = match.index + match[1].length;
  const sectionStart = headingStart + marker.length + 1;
  const nextHeading = content.slice(sectionStart).search(/\n## /);
  const insertAt = nextHeading === -1 ? content.length : sectionStart + nextHeading;
  const before = content.slice(0, insertAt).trimEnd();
  const after = content.slice(insertAt);
  return `${before}\n\n${block.trim()}\n${after}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
