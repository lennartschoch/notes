export type Visibility = "private" | "public";

export interface Note {
  id: string;
  content: string;
  owner: string;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
}

export interface Sticker {
  id: string;
  name: string;
  mime: string;
  owner: string;
  createdAt: string;
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
  me: () => request<{ email: string }>("/me"),
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
  setVisibility: (id: string, visibility: Visibility) =>
    request<Note>(`/notes/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ visibility }),
    }),
  remove: (id: string) => request<void>(`/notes/${id}`, { method: "DELETE" }),
  listStickers: () => request<Sticker[]>("/stickers"),
  createSticker: (name: string, mime: string, data: string) =>
    request<Sticker>("/stickers", {
      method: "POST",
      body: JSON.stringify({ name, mime, data }),
    }),
  removeSticker: (id: string) =>
    request<void>(`/stickers/${id}`, { method: "DELETE" }),
};

export function stickerImageUrl(id: string): string {
  return `/api/stickers/${id}/image`;
}
