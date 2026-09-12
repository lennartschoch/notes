export interface Note {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export const api = {
  list: () => request<Note[]>("/notes"),
  get: (id: string) => request<Note>(`/notes/${id}`),
  create: (content = "") =>
    request<Note>("/notes", {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  update: (id: string, content: string) =>
    request<Note>(`/notes/${id}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  remove: (id: string) => request<void>(`/notes/${id}`, { method: "DELETE" }),
};
