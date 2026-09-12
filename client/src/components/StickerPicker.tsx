import { Loader2, Plus } from "lucide-react";
import { stickerImageUrl, type Sticker } from "../api";

interface StickerPickerProps {
  stickers: Sticker[];
  loading: boolean;
  error: boolean;
  onPick: (sticker: Sticker) => void;
  onAdd: () => void;
  onClose: () => void;
}

export function StickerPicker({
  stickers,
  loading,
  error,
  onPick,
  onAdd,
  onClose,
}: StickerPickerProps) {
  return (
    <>
      <button
        type="button"
        aria-label="Close sticker picker"
        className="fixed inset-0 z-20 cursor-default"
        onClick={onClose}
      />
      <div className="absolute left-2 top-full z-30 mt-1 w-72 rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
        <div className="flex items-center justify-between px-1 pb-2">
          <span className="text-sm font-semibold text-slate-700">Stickers</span>
          <button
            type="button"
            className="flex min-h-8 items-center gap-1 rounded-lg px-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
            onClick={onAdd}
          >
            <Plus size={16} />
            Add
          </button>
        </div>

        {loading ? (
          <p className="flex items-center justify-center gap-2 p-6 text-sm text-slate-500">
            <Loader2 size={16} className="animate-spin" />
            Loading…
          </p>
        ) : error ? (
          <p className="p-6 text-center text-sm text-red-600">
            Could not load stickers.
          </p>
        ) : stickers.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">
            No stickers yet. Upload one to get started.
          </p>
        ) : (
          <div className="grid max-h-64 grid-cols-4 gap-1 overflow-y-auto">
            {stickers.map((sticker) => (
              <button
                key={sticker.id}
                type="button"
                title={sticker.name}
                className="flex h-14 w-14 items-center justify-center rounded-lg p-1 hover:bg-slate-100 active:bg-slate-200"
                onClick={() => onPick(sticker)}
              >
                <img
                  src={stickerImageUrl(sticker.id)}
                  alt={sticker.name}
                  className="max-h-12 max-w-12 object-contain"
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
