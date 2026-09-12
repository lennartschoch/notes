export type Visibility = "private" | "public";

export interface Note {
  id: string;
  content: string;
  owner: string;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
}
