export type Visibility = "private" | "public";

export interface Note {
  id: string;
  content: string;
  owner: string;
  visibility: Visibility;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// One of the account's own API keys, as the list shows it: enough to recognise a
// key, not enough to use one. The secret itself arrives once, from the call that
// makes it, and is stored nowhere readable.
export interface ApiKeyInfo {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, statusText: string, body: unknown = undefined) {
    // The server's own words when it had some, and the status when it did not: this
    // message is what a person reads on a form, and "Request failed: 401
    // Unauthorized" tells them nothing about what to do next.
    const spoken =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : "";
    super(
      spoken.length > 0 ? spoken : `Request failed: ${status} ${statusText}`,
    );
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    throw new ApiError(res.status, res.statusText, body);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

// How a caller got in. The web client cannot see an Access token or an API key
// from script code, so this is the only way it learns that it is looking at a
// credential with no password behind it — which is the difference between offering
// to change a password and explaining why it cannot.
export type SignInMethod = "access" | "apikey" | "session" | "dev";

export interface MeInfo {
  email: string;
  via: SignInMethod;
}

export interface AppConfig {
  // Whether this installation has password accounts at all, or stands behind
  // Access and nothing else.
  accounts: boolean;
  accessVerified: boolean;
  sessionHours: number;
}

// One of this account's sign-ins: one browser, one device.
export interface SessionInfo {
  id: string;
  email: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  device: string;
}

export const api = {
  me: () => request<MeInfo>("/me"),
  config: () => request<AppConfig>("/config"),
  list: () => request<Note[]>("/notes"),
  get: (id: string) => request<Note>(`/notes/${id}`),
  create: (content = "") =>
    request<Note>("/notes", {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  update: (
    id: string,
    content: string,
    version: number,
    baseContent?: string | null,
  ) =>
    request<Note>(`/notes/${id}`, {
      method: "PUT",
      // baseContent is the server text this edit descends from; sending it
      // lets the server merge instead of bouncing a version conflict. It is
      // omitted (not blank) when the client never saw that server text.
      body: JSON.stringify(
        typeof baseContent === "string"
          ? { content, version, baseContent }
          : { content, version },
      ),
    }),
  setVisibility: (id: string, visibility: Visibility) =>
    request<Note>(`/notes/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ visibility }),
    }),
  remove: (id: string) => request<void>(`/notes/${id}`, { method: "DELETE" }),
  pushPublicKey: () => request<{ key: string | null }>("/push/public-key"),
  registerPushSubscription: (subscription: PushSubscriptionJSON) =>
    request<void>("/push/subscription", {
      method: "PUT",
      body: JSON.stringify(subscription),
    }),
  unregisterPushSubscription: (endpoint: string) =>
    request<void>("/push/subscription", {
      method: "DELETE",
      body: JSON.stringify({ endpoint }),
    }),
  signIn: (email: string, password: string) =>
    request<MeInfo>("/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  signOut: () => request<void>("/logout", { method: "POST" }),
  sessions: () =>
    request<{ current: string | null; sessions: SessionInfo[] }>("/sessions"),
  revokeSession: (id: string) =>
    request<void>(`/sessions/${id}`, { method: "DELETE" }),
  signOutEverywhere: () =>
    request<{ revoked: number }>("/sessions", { method: "DELETE" }),
  changePassword: (current: string, next: string) =>
    request<{ ok: boolean }>("/password", {
      method: "POST",
      body: JSON.stringify({ current, next }),
    }),
  listKeys: () => request<ApiKeyInfo[]>("/keys"),
  createKey: (name: string) =>
    request<{ key: ApiKeyInfo; secret: string }>("/keys", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  revokeKey: (id: string) => request<void>(`/keys/${id}`, { method: "DELETE" }),
};
