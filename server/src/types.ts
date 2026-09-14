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

export interface Sticker {
  id: string;
  name: string;
  mime: string;
  owner: string;
  createdAt: string;
}
