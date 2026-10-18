import { useState } from "react";
import { api } from "../api";

// The sign-in page: the app's own door, for a deployment that has no Cloudflare
// Access in front of it. It arrives here because the API said "I don't know you"
// and this installation has accounts — behind Access, the edge answers a stranger
// long before this code runs, and the page is never shown.

interface SignInProps {
  onSignedIn: (email: string) => void;
}

export default function SignIn({ onSignedIn }: SignInProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const me = await api.signIn(email, password);
      onSignedIn(me.email);
    } catch (cause) {
      // Whatever the reason — wrong password, a name nobody has here, too many
      // tries — the server already chose the one answer worth showing.
      setError(cause instanceof Error ? cause.message : "Could not sign in.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10 text-slate-900">
      <form
        onSubmit={(event) => void submit(event)}
        data-sign-in
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h1 className="m-0 text-xl font-semibold">Notes</h1>
        <p className="mt-1 mb-5 text-[0.875rem] text-slate-500">
          Sign in to your own notes.
        </p>

        <label className="block text-[0.8125rem] font-medium text-slate-700">
          Email address
          <input
            type="email"
            name="email"
            autoComplete="username"
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 mb-3 block h-11 w-full rounded-lg border border-slate-200 px-3 text-[0.9375rem] outline-none focus:border-slate-400"
          />
        </label>

        <label className="block text-[0.8125rem] font-medium text-slate-700">
          Password
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 block h-11 w-full rounded-lg border border-slate-200 px-3 text-[0.9375rem] outline-none focus:border-slate-400"
          />
        </label>

        {error !== null && (
          <p
            className="mt-4 mb-0 rounded-lg bg-red-50 px-3 py-2 text-[0.8125rem] text-red-700"
            role="alert"
            data-signin-error
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || email.trim().length === 0 || password.length === 0}
          className="mt-5 h-11 w-full rounded-lg bg-slate-900 px-4 text-[0.9375rem] font-medium text-white hover:bg-slate-700 active:bg-slate-700 disabled:opacity-40"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
