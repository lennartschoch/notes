export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProcessOptions {
  removeBackground: boolean;
  tolerance: number;
}

// Longest side of the stored sticker. Inline stickers render around 1.3em,
// so anything larger is wasted bytes and bandwidth.
const MAX_SIZE = 512;

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), {
      once: true,
    });
    reader.addEventListener(
      "error",
      () => reject(new Error("Could not read the image")),
      { once: true },
    );
    reader.readAsDataURL(file);
  });
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error("Could not load the image")),
      { once: true },
    );
    image.src = src;
  });
}

// Flood-fills transparent pixels inward from every border pixel whose colour
// is within `tolerance` of the border pixel that started that region. This
// strips flat or gently shaded sticker backgrounds while leaving the subject
// (which normally has a contrasting edge) intact.
function removeBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  tolerance: number,
): void {
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  let head = 0;

  // Queue entries are four numbers: pixel index followed by the reference
  // colour (r, g, b) of the border region it belongs to.
  const seed = (x: number, y: number) => {
    const index = y * width + x;
    if (visited[index]) return;
    visited[index] = 1;
    const offset = index * 4;
    queue.push(index, data[offset], data[offset + 1], data[offset + 2]);
  };

  for (let x = 0; x < width; x += 1) {
    seed(x, 0);
    seed(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    seed(0, y);
    seed(width - 1, y);
  }

  while (head < queue.length) {
    const index = queue[head++];
    const r = queue[head++];
    const g = queue[head++];
    const b = queue[head++];
    const offset = index * 4;

    if (data[offset + 3] !== 0) {
      const diff = Math.max(
        Math.abs(data[offset] - r),
        Math.abs(data[offset + 1] - g),
        Math.abs(data[offset + 2] - b),
      );
      if (diff > tolerance) continue;
      data[offset + 3] = 0;
    }

    const x = index % width;
    const y = (index - x) / width;
    const spread = (nx: number, ny: number) => {
      const next = ny * width + nx;
      if (visited[next]) return;
      visited[next] = 1;
      queue.push(next, r, g, b);
    };
    if (x > 0) spread(x - 1, y);
    if (x < width - 1) spread(x + 1, y);
    if (y > 0) spread(x, y - 1);
    if (y < height - 1) spread(x, y + 1);
  }

  ctx.putImageData(imageData, 0, 0);
}

export function renderSticker(
  image: HTMLImageElement,
  crop: CropRect,
  options: ProcessOptions,
): HTMLCanvasElement {
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  const sx = Math.round(crop.x * sourceWidth);
  const sy = Math.round(crop.y * sourceHeight);
  const sw = Math.max(1, Math.round(crop.width * sourceWidth));
  const sh = Math.max(1, Math.round(crop.height * sourceHeight));

  const scale = Math.min(1, MAX_SIZE / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, width, height);

  if (options.removeBackground) {
    removeBackground(ctx, width, height, options.tolerance);
  }
  return canvas;
}
