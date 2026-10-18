import { useCallback, useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { api, type ApiKeyInfo } from "../api";
import { day, usedAgo } from "../format";
import Dialog from "./Dialog";

// The account's API keys: the credentials an AI agent uses to reach the notes as
// this account, without Cloudflare Access. A key sees everything its owner sees —
// that is what makes it useful, and what makes revoking it worth a confirmation.
//
// The name of a key is the owner's own note about it. It is never sent anywhere
// else: not into a note, not into a presence chip, not into a notification. Other
// people are told that an agent is at work, and never which of your keys it is.

interface AgentKeysProps {
  onClose: () => void;
}

export default function AgentKeys({ onClose }: AgentKeysProps) {
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The one secret this screen ever holds, and only until it closes: a key is
  // never shown again, which is why the list keeps a few characters of each.
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // A clipboard needs a secure context, and a self-hosted notes app on the LAN is
  // often plain http. Without one the key is simply selectable text.
  const canCopy =
    typeof navigator !== "undefined" && Boolean(navigator.clipboard);

  const refresh = useCallback(() => {
    api.listKeys().then(
      (list) => {
        setKeys(list);
        setError(null);
      },
      () => {
        setKeys([]);
        setError("Could not read your keys.");
      },
    );
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function createKey() {
    if (busy) return;
    setBusy(true);
    try {
      const created = await api.createKey(name.trim() || "unnamed key");
      setSecret(created.secret);
      setCopied(false);
      setName("");
      setError(null);
      setKeys(await api.listKeys());
    } catch {
      setError("Could not create a key.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(key: ApiKeyInfo) {
    const sure = window.confirm(
      `Revoke “${key.name}”? An agent using it loses access immediately.`,
    );
    if (!sure) return;
    try {
      await api.revokeKey(key.id);
      setError(null);
      setKeys(await api.listKeys());
    } catch {
      setError("Could not revoke that key.");
    }
  }

  async function copySecret() {
    if (!secret || !canCopy) return;
    await navigator.clipboard.writeText(secret).then(
      () => setCopied(true),
      () => setError("Could not copy — select the key and copy it by hand."),
    );
  }

  return (
    <Dialog
      label="Agent keys"
      title="Agent keys"
      subtitle="Let an AI agent read and write your notes as you."
      onClose={onClose}
      footer={
        <>
          <input
            type="text"
            value={name}
            maxLength={48}
            placeholder="Name this key, e.g. laptop agent"
            aria-label="Key name"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createKey();
            }}
            className="h-11 min-w-0 flex-1 rounded-lg border border-slate-200 px-3 text-[0.875rem] outline-none focus:border-slate-400"
          />
          <button
            type="button"
            className="h-11 flex-none rounded-lg bg-slate-900 px-4 text-[0.875rem] font-medium text-white hover:bg-slate-700 active:bg-slate-700 disabled:opacity-40"
            onClick={() => void createKey()}
            disabled={busy}
          >
            Create key
          </button>
        </>
      }
    >
      {secret !== null && (
        <div
          className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3"
          data-api-key-created
        >
          <p className="m-0 text-[0.8125rem] font-medium text-emerald-900">
            Copy it now — this is the only time it is shown.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code
              data-api-secret
              className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap rounded bg-white px-2 py-1.5 font-mono text-[0.75rem]"
            >
              {secret}
            </code>
            {canCopy && (
              <button
                type="button"
                className="flex h-9 flex-none items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 text-[0.8125rem] font-medium text-emerald-900 hover:bg-emerald-100 active:bg-emerald-100"
                onClick={() => void copySecret()}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "Copied" : "Copy"}
              </button>
            )}
          </div>
        </div>
      )}

      <p className="m-0 mb-3 text-[0.8125rem] text-slate-500">
        A key acts as your whole account, including deleting notes and making
        them public. Give one to a machine you trust, and revoke it the moment
        you stop trusting it.
      </p>

      {keys === null ? (
        <p className="m-0 py-2 text-[0.8125rem] text-slate-500">Loading…</p>
      ) : keys.length === 0 ? (
        <p className="m-0 py-2 text-[0.8125rem] text-slate-500">No keys yet.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {keys.map((key) => (
            <li
              key={key.id}
              className="flex items-center gap-3 border-b border-slate-100 py-2.5 last:border-b-0"
              data-api-key={key.id}
            >
              <div className="min-w-0 flex-1">
                <p className="m-0 truncate text-[0.875rem] font-medium">
                  {key.name}
                </p>
                <p className="m-0 truncate text-[0.75rem] text-slate-500">
                  ends {key.hint} · created {day(key.createdAt)} · used{" "}
                  {usedAgo(key.lastUsedAt)}
                </p>
              </div>
              <button
                type="button"
                className="h-9 flex-none rounded-lg border border-slate-200 px-3 text-[0.8125rem] font-medium text-slate-700 hover:bg-red-50 hover:text-red-600 active:bg-red-50"
                onClick={() => void revokeKey(key)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      {error !== null && (
        <p
          className="m-0 pt-2 text-[0.8125rem] text-red-600"
          aria-live="polite"
        >
          {error}
        </p>
      )}
    </Dialog>
  );
}
