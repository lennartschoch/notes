export type Visibility = "private" | "public";

// Who made a change: the account it acted as, and whether an AI agent (rather
// than the person) was driving. `agent` is a boolean for the same reason the
// live protocol keeps it one — the account model allows a single agent per
// account, and a name chosen by the agent would be spoofable. Everything that
// must tell a person apart from their own agent (push text, presence, carets)
// keys on this, not on the bare email.
export interface Actor {
  email: string;
  agent?: boolean;
  // Identifies the connection this actor was resolved from, for the one thing
  // an email cannot tell apart: two agents acting as the same account. Live
  // presence uses it to take an agent's carets out of every room when its MCP
  // session closes.
  sessionId?: string;
}

// The label shown to people for an actor. Owned by the server, never the agent.
export function actorLabel(actor: Actor): string {
  return actor.agent ? `${actor.email}\u2019s agent` : actor.email;
}

// The body line of a change notification. Named actors, agents attributed, and a
// count of everyone else — the wording that makes "an agent edited this" legible
// without exposing anything the agent chose for itself.
export function pushBody(editors: Actor[]): string {
  if (editors.length === 0) return "Updated by someone";
  const first = actorLabel(editors[0]!);
  if (editors.length === 1) return `Updated by ${first}`;
  const others = editors.length - 1;
  return `Updated by ${first} and ${others} other${others === 1 ? "" : "s"}`;
}

export interface Note {
  id: string;
  content: string;
  owner: string;
  visibility: Visibility;
  version: number;
  createdAt: string;
  updatedAt: string;
}
