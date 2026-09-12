import { useEffect, useRef } from "react";
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

// Corner handles are rendered outside the clipped shadow layer so they are
// never cut off at the image edge, and are given a ~36px touch target.
const HANDLES: {
  mode: DragMode;
  position: (crop: CropRect) => { left: string; top: string };
}[] = [
  {
    mode: "nw",
    position: (c) => ({ left: `${c.x * 100}%`, top: `${c.y * 100}%` }),
  },
  {
    mode: "ne",
    position: (c) => ({
      left: `${(c.x + c.width) * 100}%`,
      top: `${c.y * 100}%`,
    }),
  },
  {
    mode: "sw",
    position: (c) => ({
      left: `${c.x * 100}%`,
      top: `${(c.y + c.height) * 100}%`,
    }),
  },
  {
    mode: "se",
    position: (c) => ({
      left: `${(c.x + c.width) * 100}%`,
      top: `${(c.y + c.height) * 100}%`,
    }),
  },
];

export function ImageCropper({ src, crop, onChange }: ImageCropperProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const drag = useRef<DragState | null>(null);
  const onChangeRef = useRef(onChange);
  const cropRef = useRef(crop);

  useEffect(() => {
    onChangeRef.current = onChange;
    cropRef.current = crop;
  });

  // Track the gesture on window rather than the small handle element: touch
  // pointers drift off the handle and the dialog's scroll container would
  // otherwise swallow the move. `pointercancel` (e.g. the browser deciding the
  // touch was a scroll) ends the gesture cleanly.
  useEffect(() => {
    function handleMove(event: PointerEvent) {
      const state = drag.current;
      const image = imageRef.current;
      if (!state || !image) return;
      event.preventDefault();
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

      onChangeRef.current({ x, y, width, height });
    }

    function handleEnd() {
      drag.current = null;
    }

    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleEnd);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
    };
  }, []);

  function begin(mode: DragMode, event: ReactPointerEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    drag.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startCrop: cropRef.current,
    };
  }

  return (
    <div
      className="relative inline-block touch-none select-none"
      style={{ touchAction: "none" }}
    >
      <div className="relative overflow-hidden rounded-lg bg-slate-100">
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
            touchAction: "none",
          }}
          onPointerDown={(event) => begin("move", event)}
        />
      </div>
      {HANDLES.map((handle) => (
        <span
          key={handle.mode}
          role="presentation"
          className="absolute flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
          style={{ ...handle.position(crop), touchAction: "none" }}
          onPointerDown={(event) => begin(handle.mode, event)}
        >
          <span className="h-3.5 w-3.5 rounded-full border border-slate-400 bg-white shadow" />
        </span>
      ))}
    </div>
  );
}
