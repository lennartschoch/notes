import { Loader2, Sparkles, Upload, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type Sticker } from "../api";
import { ImageCropper } from "./ImageCropper";
import {
  loadImage,
  readFileAsDataUrl,
  renderSticker,
  type CropRect,
} from "./stickerImage";

const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };
const OUTPUT_MIME = "image/png";

interface StickerUploadDialogProps {
  onClose: () => void;
  onCreated: (sticker: Sticker) => void;
}

export function StickerUploadDialog({
  onClose,
  onCreated,
}: StickerUploadDialogProps) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropRect>(FULL_CROP);
  const [name, setName] = useState("");
  const [removeBg, setRemoveBg] = useState(false);
  const [tolerance, setTolerance] = useState(32);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const preview = useMemo(() => {
    if (!image) return null;
    return renderSticker(image, crop, {
      removeBackground: removeBg,
      tolerance,
    }).toDataURL(OUTPUT_MIME);
  }, [image, crop, removeBg, tolerance]);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const loaded = await loadImage(dataUrl);
      setSource(dataUrl);
      setImage(loaded);
      setCrop(FULL_CROP);
      setName(file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "Sticker");
      setRemoveBg(false);
    } catch {
      setError("That file could not be opened as an image.");
    }
  }

  async function save() {
    if (!image) return;
    setBusy(true);
    setError(null);
    try {
      const dataUrl = renderSticker(image, crop, {
        removeBackground: removeBg,
        tolerance,
      }).toDataURL(OUTPUT_MIME);
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const sticker = await api.createSticker(name, OUTPUT_MIME, base64);
      onCreated(sticker);
    } catch {
      setError("Upload failed. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close dialog"
        className="absolute inset-0 cursor-default bg-slate-900/50"
        onClick={() => {
          if (!busy) onClose();
        }}
      />
      <dialog
        open
        aria-label="Add sticker"
        className="relative m-0 flex max-h-[90vh] w-full max-w-lg flex-col overflow-y-auto rounded-2xl border-0 bg-white p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="m-0 text-lg font-semibold">Add sticker</h2>
          <button
            type="button"
            aria-label="Close"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
            onClick={onClose}
            disabled={busy}
          >
            <X size={20} />
          </button>
        </div>

        {!image ? (
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 p-10 text-center text-slate-500 hover:bg-slate-50">
            <Upload size={28} />
            <span className="font-medium text-slate-700">
              Choose an image to upload
            </span>
            <span className="text-sm">PNG, JPEG, WebP or GIF</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(event) => void handleFile(event.target.files?.[0])}
            />
          </label>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex justify-center">
              {source && (
                <ImageCropper src={source} crop={crop} onChange={setCrop} />
              )}
            </div>

            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
              Name
              <input
                type="text"
                value={name}
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
                className="min-h-10 rounded-lg border border-slate-300 px-3 font-normal text-slate-900 outline-none focus:border-slate-500"
              />
            </label>

            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={removeBg}
                onChange={(event) => setRemoveBg(event.target.checked)}
                className="h-4 w-4 accent-slate-900"
              />
              <Sparkles size={16} />
              Remove background
            </label>

            {removeBg && (
              <label className="flex flex-wrap items-center justify-between gap-1 text-sm text-slate-600">
                Colour tolerance
                <span>{tolerance}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={tolerance}
                  onChange={(event) => setTolerance(Number(event.target.value))}
                  className="w-full accent-slate-900"
                />
              </label>
            )}

            <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
              <span className="text-sm font-medium text-slate-600">
                Preview
              </span>
              <span
                className="flex h-16 w-16 items-center justify-center rounded-lg bg-[repeating-conic-gradient(#e2e8f0_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]"
                aria-label="Sticker preview"
              >
                {preview && (
                  <img
                    src={preview}
                    alt=""
                    className="max-h-14 max-w-14 object-contain"
                  />
                )}
              </span>
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="min-h-10 rounded-lg px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="flex min-h-10 items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
            onClick={() => void save()}
            disabled={!image || busy}
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            Save sticker
          </button>
        </div>
      </dialog>
    </div>
  );
}
