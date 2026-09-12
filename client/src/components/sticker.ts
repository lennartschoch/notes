import { createInlineMarkdownSpec, mergeAttributes, Node } from "@tiptap/core";
import { stickerImageUrl } from "../api";

export interface StickerAttrs {
  id: string;
  name: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    sticker: {
      insertSticker: (attrs: StickerAttrs) => ReturnType;
    };
  }
}

// Markdown representation: [sticker id="…" name="…"], a self-closing inline
// shortcode that round-trips through the shared sticker library.
const markdownSpec = createInlineMarkdownSpec({
  nodeName: "sticker",
  selfClosing: true,
  allowedAttributes: ["id", "name"],
});

export const Sticker = Node.create({
  name: "sticker",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: { default: null },
      name: { default: "" },
    };
  },

  parseHTML() {
    return [
      {
        tag: "img[data-sticker]",
        getAttrs: (element) => {
          if (typeof element === "string") return false;
          const id = element.getAttribute("data-id");
          if (!id) return false;
          return { id, name: element.getAttribute("data-name") ?? "" };
        },
      },
    ];
  },

  renderHTML({ node }) {
    return [
      "img",
      mergeAttributes({
        "data-sticker": "",
        "data-id": node.attrs.id,
        "data-name": node.attrs.name,
        src: stickerImageUrl(String(node.attrs.id)),
        alt: node.attrs.name || "Sticker",
        class: "note-sticker",
      }),
    ];
  },

  addCommands() {
    return {
      insertSticker:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },

  ...markdownSpec,
});
