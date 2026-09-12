import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { CropRect } from "./stickerImage";

interface ImageCropperProps {
  src: string;
  crop: CropRect;
  onChange: (crop: CropRect) => void;
}

type DragMode = "move" | "nw" | "ne" | "sw" | "se";

interface DragState {
  mode: DragMode;
  startX: number;
  startY: number;
  startCrop: CropRect;
}

const MIN_SIZE = 0.05;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const HANDLES: { mode: DragMode; className: string }[] = [
  { mode: "nw", className: "-left-2 -top-2" },
  { mode: "ne", className: "-right-2 -top-2" },
  { mode: "sw", className: "-bottom-2 -left-2" },
  { mode: "se", className: "-bottom-2 -right-2" },
];

export function ImageCropper({ src, crop, onChange }: ImageCropperProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const drag = useRef<DragState | null>(null);

  function begin(mode: DragMode, event: ReactPointerEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startCrop: crop,
    };
  }

  function move(event: ReactPointerEvent<HTMLElement>) {
    const state = drag.current;
    const image = imageRef.current;
    if (!state || !image) return;
    const rect = image.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dx = (event.clientX - state.startX) / rect.width;
    const dy = (event.clientY - state.startY) / rect.height;
    const start = state.startCrop;
    let { x, y, width, height } = start;

    if (state.mode === "move") {
      x = clamp(start.x + dx, 0, 1 - start.width);
      y = clamp(start.y + dy, 0, 1 - start.height);
    } else {
      if (state.mode.includes("w")) {
        x = clamp(start.x + dx, 0, start.x + start.width - MIN_SIZE);
        width = start.x + start.width - x;
      }
      if (state.mode.includes("e")) {
        width = clamp(start.width + dx, MIN_SIZE, 1 - start.x);
      }
      if (state.mode.includes("n")) {
        y = clamp(start.y + dy, 0, start.y + start.height - MIN_SIZE);
        height = start.y + start.height - y;
      }
      if (state.mode.includes("s")) {
        height = clamp(start.height + dy, MIN_SIZE, 1 - start.y);
      }
    }

    onChange({ x, y, width, height });
  }

  function end(event: ReactPointerEvent<HTMLElement>) {
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <div className="relative inline-block touch-none select-none overflow-hidden rounded-lg bg-slate-100">
      <img
        ref={imageRef}
        src={src}
        alt="Sticker to crop"
        draggable={false}
        className="block max-h-[45vh] max-w-full"
      />
      <div
        className="absolute cursor-move border border-white/90 shadow-[0_0_0_9999px_rgba(15,23,42,0.45)]"
        style={{
          left: `${crop.x * 100}%`,
          top: `${crop.y * 100}%`,
          width: `${crop.width * 100}%`,
          height: `${crop.height * 100}%`,
        }}
        onPointerDown={(event) => begin("move", event)}
        onPointerMove={move}
        onPointerUp={end}
      >
        {HANDLES.map((handle) => (
          <span
            key={handle.mode}
            role="presentation"
            className={`absolute h-4 w-4 rounded-full border border-slate-400 bg-white shadow ${handle.className}`}
            onPointerDown={(event) => begin(handle.mode, event)}
            onPointerMove={move}
            onPointerUp={end}
          />
        ))}
      </div>
    </div>
  );
}
