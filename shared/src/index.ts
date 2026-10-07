// Text helpers shared by the server (push notifier, MCP tools) and the web
// client, so a note is titled the same way everywhere it is listed. This is
// the whole point of this workspace: import from "shared" rather than
// re-implementing a title heuristic next to the component that needs it.

export function noteTitle(content: string): string {
  const firstLine = content.split("\n").find((line) => line.trim().length > 0);
  const title = (firstLine ?? "").replace(/^\s{0,3}#{1,6}\s+/, "").trim();
  return title.slice(0, 60) || "Untitled note";
}

// Drop markdown decoration so a list of notes reads like a list of sentences.
function stripMarkdown(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/\|/g, " ");
}

// Single-line plain-text summary, used in listings and search results.
export function notePreview(content: string, maxChars = 100): string {
  const text = stripMarkdown(content).replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SearchOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  contextLines?: number;
}

// One line of a note, either a matching line (hit) or surrounding context.
export interface MatchedLine {
  line: number;
  text: string;
  hit: boolean;
}

export interface SearchResults {
  hits: number;
  lines: MatchedLine[];
}

// Line-based search inside one note. Notes are small markdown documents, so a
// per-line scan gives readable line numbers without a real indexer.
export function searchContent(
  content: string,
  query: string,
  options: SearchOptions = {},
): SearchResults {
  const flags = options.caseSensitive ? "" : "i";
  const pattern = options.regex ? query : escapeRegExp(query);
  // Throws on an invalid user-supplied pattern; callers turn it into a tool error.
  const re = new RegExp(pattern, flags);

  const lines = content.split("\n");
  const matched = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    if (re.test(lines[index])) matched.add(index);
    re.lastIndex = 0;
  }

  const context = Math.max(0, Math.min(options.contextLines ?? 0, 5));
  const shown = new Set<number>();
  for (const index of matched) {
    for (let offset = -context; offset <= context; offset += 1) {
      const neighbour = index + offset;
      if (neighbour >= 0 && neighbour < lines.length) shown.add(neighbour);
    }
  }

  return {
    hits: matched.size,
    lines: [...shown]
      .toSorted((a, b) => a - b)
      .map((index) => ({
        line: index + 1,
        text: lines[index].replace(/\s+$/, "").slice(0, 300),
        hit: matched.has(index),
      })),
  };
}
