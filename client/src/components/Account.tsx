import { useCallback, useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import { api, type MeInfo, type SessionInfo } from "../api";
import { day, usedAgo, clockTime, deviceName } from "../format";
import Dialog from "./Dialog";

// The account itself: how you got in, what that means for changing it, and which
// devices are holding on to it.
//
// Two of these are the same risk seen from two sides. A key is a machine the
// account trusts; a session is a browser that does. Both are listed here because
// the thing a person wants, on finding one they do not recognise, is the button
// that makes it stop.

interface AccountProps {
  me: MeInfo;
  onClose: () => void;
  onNeedSignIn: () => void;
}

const METHOD_LABEL: Record<MeInfo["via"], string> = {
  access: "through Cloudflare Access",
  session: "with your password",
  apikey: "with an API key",
  dev: "as a development identity",
};

export default function Account({ me, onClose, onNeedSignIn }: AccountProps) {
  const [sessions, setSessions] = useState<{
    current: string | null;
    sessions: SessionInfo[];
  } | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canChangePassword = me.via === "session" || me.via === "dev";

  const refresh = useCallback(() => {
    api.sessions().then(
      (list) => {
        setSessions(list);
        setError(null);
      },
      () => setError("Could not read your sign-ins."),
    );
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function signOut() {
    try {
      await api.signOut();
    } finally {
      // Signed out is signed out: the panel has nothing left to show.
      onNeedSignIn();
    }
  }

  async function signOutEverywhere() {
    if (
      !window.confirm(
        "Sign out of every device, including this one? Agents keep working — those are keys, not sign-ins.",
      )
    )
      return;
    try {
      await api.signOutEverywhere();
    } finally {
      onNeedSignIn();
    }
  }

  async function revoke(session: SessionInfo) {
    if (!window.confirm(`Sign out ${deviceName(session.device)}?`)) return;
    try {
      await api.revokeSession(session.id);
      refresh();
    } catch {
      setError("Could not sign that device out.");
    }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.changePassword(current, next);
      // The server ended every session, this one included: there is nothing to
      // keep here.
      setNotice("Password changed. Sign in again.");
      setCurrent("");
      setNext("");
      onNeedSignIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      label="Account"
      title="Account"
      subtitle={me.email}
      onClose={onClose}
    >
      <p className="m-0 mb-4 text-[0.8125rem] text-slate-500">
        Signed in {METHOD_LABEL[me.via]}.
      </p>

      {canChangePassword && (
        <form
          onSubmit={(event) => void changePassword(event)}
          className="mb-5 border-t border-slate-100 pt-4"
        >
          <h3 className="m-0 mb-1 text-[0.8125rem] font-semibold">
            Change password
          </h3>
          <p className="m-0 mb-3 text-[0.8125rem] text-slate-500">
            Changing it signs every device out, this one included.
          </p>
          <input
            type="password"
            name="current"
            autoComplete="current-password"
            placeholder="Current password"
            aria-label="Current password"
            required
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            className="mb-2 h-11 w-full rounded-lg border border-slate-200 px-3 text-[0.875rem] outline-none focus:border-slate-400"
          />
          <input
            type="password"
            name="next"
            autoComplete="new-password"
            placeholder="New password, at least 10 characters"
            aria-label="New password"
            required
            minLength={10}
            value={next}
            onChange={(event) => setNext(event.target.value)}
            className="h-11 w-full rounded-lg border border-slate-200 px-3 text-[0.875rem] outline-none focus:border-slate-400"
          />
          <button
            type="submit"
            disabled={busy || current.length === 0 || next.length < 10}
            className="mt-3 h-11 rounded-lg bg-slate-900 px-4 text-[0.875rem] font-medium text-white hover:bg-slate-700 active:bg-slate-700 disabled:opacity-40"
          >
            {busy ? "Changing…" : "Change password"}
          </button>
        </form>
      )}

      <div className="border-t border-slate-100 pt-4">
        <h3 className="m-0 mb-1 text-[0.8125rem] font-semibold">
          Signed in on
        </h3>
        {sessions === null ? (
          <p className="m-0 py-2 text-[0.8125rem] text-slate-500">Loading…</p>
        ) : sessions.sessions.length === 0 ? (
          <p className="m-0 py-2 text-[0.8125rem] text-slate-500">
            No browser sign-ins.
          </p>
        ) : (
          <ul className="m-0 list-none p-0">
            {sessions.sessions.map((session) => (
              <li
                key={session.id}
                className="flex items-center gap-3 border-b border-slate-100 py-2.5 last:border-b-0"
                data-session={session.id}
              >
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-[0.875rem] font-medium">
                    {deviceName(session.device)}
                    {session.id === sessions.current ? " · this device" : ""}
                  </p>
                  <p className="m-0 truncate text-[0.75rem] text-slate-500">
                    signed in {day(session.createdAt)}{" "}
                    {clockTime(session.createdAt)}· used{" "}
                    {usedAgo(session.lastUsedAt)}
                  </p>
                </div>
                {session.id !== sessions.current && (
                  <button
                    type="button"
                    className="h-9 flex-none rounded-lg border border-slate-200 px-3 text-[0.8125rem] font-medium text-slate-700 hover:bg-red-50 hover:text-red-600 active:bg-red-50"
                    onClick={() => void revoke(session)}
                  >
                    Sign out
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {notice !== null && (
        <p
          className="mt-3 mb-0 text-[0.8125rem] text-emerald-700"
          aria-live="polite"
        >
          {notice}
        </p>
      )}
      {error !== null && (
        <p
          className="mt-3 mb-0 text-[0.8125rem] text-red-600"
          aria-live="polite"
        >
          {error}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
        <button
          type="button"
          className="flex h-11 items-center gap-2 rounded-lg bg-slate-900 px-4 text-[0.875rem] font-medium text-white hover:bg-slate-700 active:bg-slate-700"
          onClick={() => void signOut()}
        >
          <LogOut size={16} />
          Sign out
        </button>
        <button
          type="button"
          className="h-11 rounded-lg border border-slate-200 px-4 text-[0.875rem] font-medium text-slate-700 hover:bg-red-50 hover:text-red-600 active:bg-red-50"
          onClick={() => void signOutEverywhere()}
        >
          Sign out everywhere
        </button>
      </div>
    </Dialog>
  );
}
