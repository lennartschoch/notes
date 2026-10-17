import { CARET_ANCHOR_CHARS, type LiveCursor } from "shared";

// Locating carets in a document, free of React and of any live editor: the
// editor measures, but the *meaning* of a caret — where it is, where it
// should be after the text moved, what color it wears — lives here, where it
// can be tested against any document-shaped thing.

// A minimal structural view of a ProseMirror document: enough to find text
// and know where the end is, which is also enough to fake in a test.
export interface TextDoc {
  content: { size: number };
  descendants(
    fn: (node: { isText?: boolean; text?: string }, pos: number) => unknown,
  ): unknown;
}

// Every character in the document with the position it sits at, so a caret
// can be relocated in a document that was rebuilt from markdown.
export function textMap(doc: TextDoc): { text: string; positions: number[] } {
  let text = "";
  const positions: number[] = [];
  doc.descendants((node, position) => {
    if (!node.isText || !node.text) return;
    for (let offset = 0; offset < node.text.length; offset += 1) {
      text += node.text[offset];
      positions.push(position + offset);
    }
  });
  return { text, positions };
}

export function caretAnchor(doc: TextDoc, caret: number): string {
  const { text, positions } = textMap(doc);
  let end = positions.findIndex((position) => position >= caret);
  if (end === -1) end = positions.length;
  return text.slice(Math.max(0, end - CARET_ANCHOR_CHARS), end);
}

export function positionOfText(doc: TextDoc, anchor: string): number | null {
  if (anchor.trim() === "") return null;
  const { text, positions } = textMap(doc);
  const index = text.indexOf(anchor);
  if (index === -1) return null;
  return (
    positions[index + anchor.length] ?? positions[positions.length - 1] ?? null
  );
}

// Which document position a peer's caret refers to: trusted outright when
// both copies still sit at the same version, otherwise relocated by the
// text it sits behind, and clamped to the document as a last resort.
export function resolveCaretPosition(
  caret: LiveCursor,
  doc: TextDoc,
  ourVersion: number,
): number | null {
  if (caret.position === null) return null;
  const size = doc.content.size;
  if (
    caret.version === ourVersion &&
    caret.version >= 0 &&
    caret.position <= size
  ) {
    return caret.position;
  }
  const found = positionOfText(doc, caret.anchor);
  if (found !== null) return found;
  return Math.min(caret.position, size);
}

// A remote caret, measured into pixels for the overlay layer.
export interface PeerCaret {
  email: string;
  left: number;
  top: number;
  height: number;
  color: string;
}

// A stable color per person, so two peers are never the same shade.
export function caretColor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i += 1) {
    hash = (hash * 31 + email.charCodeAt(i)) | 0;
  }
  return `hsl(${Math.abs(hash) % 360} 72% 45%)`;
}
