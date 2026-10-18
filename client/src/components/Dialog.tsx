import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

// One modal, so the panels that show credentials all behave the same way: a native
// dialog keeps focus inside itself, closes on Escape, and reports the `close` event
// whichever way it was closed.

interface DialogProps {
  label: string;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export default function Dialog({
  label,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-label={label}
      onClose={onClose}
      className="m-auto max-h-[85dvh] w-full max-w-lg rounded-xl border-none bg-white p-0 text-slate-900 shadow-xl [&::backdrop]:bg-slate-900/40"
    >
      <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="m-0 text-base font-semibold">{title}</h2>
          {subtitle && (
            <p className="m-0 text-[0.8125rem] text-slate-500">{subtitle}</p>
          )}
        </div>
        <button
          type="button"
          className="-mr-2 flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 active:bg-slate-100"
          onClick={() => dialog.current?.close()}
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </header>

      <div className="max-h-[55dvh] overflow-y-auto px-4 py-3">{children}</div>

      {footer && (
        <footer className="flex items-center gap-2 border-t border-slate-200 px-4 py-3">
          {footer}
        </footer>
      )}
    </dialog>
  );
}
