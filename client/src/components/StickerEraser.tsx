import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  paintEraseStrokes,
  type CropRect,
  type EraseStroke,
  type StrokePoint,
} from "./stickerImage";

interface StickerEraserProps {
  base: HTMLCanvasElement;
  crop: CropRect;
  naturalWidth: number;
  naturalHeight: number;
  strokes: EraseStroke[];
  // Brush radius as a fraction of the source image's shorter side.
  brush: number;
  onStrokesChange: (strokes: EraseStroke[]) => void;
}

function canvasPoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): StrokePoint {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * canvas.width,
    y: ((clientY - rect.top) / rect.height) * canvas.height,
  };
}

function sourcePoint(
  canvas: HTMLCanvasElement,
  crop: CropRect,
  clientX: number,
  clientY: number,
): StrokePoint {
  const rect = canvas.getBoundingClientRect();
  return {
    x: crop.x + ((clientX - rect.left) / rect.width) * crop.width,
    y: crop.y + ((clientY - rect.top) / rect.height) * crop.height,
  };
}

function radiusPixels(
  canvas: HTMLCanvasElement,
  crop: CropRect,
  brush: number,
  naturalWidth: number,
  naturalHeight: number,
): number {
  if (crop.width === 0) return 1;
  const scale = canvas.width / (crop.width * naturalWidth);
  return Math.max(1, brush * Math.min(naturalWidth, naturalHeight) * scale);
}

export function StickerEraser({
  base,
  crop,
  naturalWidth,
  naturalHeight,
  strokes,
  brush,
  onStrokesChange,
}: StickerEraserProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef<EraseStroke | null>(null);
  const latest = useRef({
    crop,
    brush,
    strokes,
    naturalWidth,
    naturalHeight,
    onStrokesChange,
  });

  useEffect(() => {
    latest.current = {
      crop,
      brush,
      strokes,
      naturalWidth,
      naturalHeight,
      onStrokesChange,
    };
  });

  // Repaint the base image plus every committed stroke. Pointer movement is
  // drawn incrementally on top for latency; committing a stroke re-runs this.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = base.width;
    canvas.height = base.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    paintEraseStrokes(ctx, crop, strokes, naturalWidth, naturalHeight);
  }, [base, crop, strokes, naturalWidth, naturalHeight]);

  useEffect(() => {
    function handleMove(event: PointerEvent) {
      const stroke = live.current;
      const canvas = canvasRef.current;
      if (!stroke || !canvas) return;
      event.preventDefault();
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const state = latest.current;
      const from = stroke.points[stroke.points.length - 1];
      const start = {
        x: ((from.x - state.crop.x) / state.crop.width) * canvas.width,
        y: ((from.y - state.crop.y) / state.crop.height) * canvas.height,
      };
      const to = canvasPoint(canvas, event.clientX, event.clientY);
      stroke.points.push(
        sourcePoint(canvas, state.crop, event.clientX, event.clientY),
      );
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "#000";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth =
        radiusPixels(
          canvas,
          state.crop,
          state.brush,
          state.naturalWidth,
          state.naturalHeight,
        ) * 2;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.restore();
    }

    function handleEnd() {
      const stroke = live.current;
      if (!stroke) return;
      live.current = null;
      latest.current.onStrokesChange([...latest.current.strokes, stroke]);
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

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const point = sourcePoint(canvas, crop, event.clientX, event.clientY);
    live.current = { points: [point], radius: brush };
    const { x, y } = canvasPoint(canvas, event.clientX, event.clientY);
    const radius = radiusPixels(
      canvas,
      crop,
      brush,
      naturalWidth,
      naturalHeight,
    );
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  return (
    <div className="inline-block rounded-lg bg-[repeating-conic-gradient(#e2e8f0_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
      <canvas
        ref={canvasRef}
        aria-label="Erase parts of the sticker"
        className="block h-auto max-h-[45vh] max-w-full cursor-crosshair touch-none rounded-lg"
        style={{ touchAction: "none" }}
        onPointerDown={handlePointerDown}
      />
    </div>
  );
}
