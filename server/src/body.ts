import type { Request, Response } from "express";
import { z } from "zod";

// Request bodies, spoken in the same zod the MCP tools and the persisted stores
// use. parseBody writes the 400 and returns undefined when a body does not match,
// so handlers only ever see typed input.
export function parseBody<S extends z.ZodType>(
  schema: S,
  req: Request,
  res: Response,
): z.infer<S> | undefined {
  const parsed = schema.safeParse(req.body ?? {});
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
  res.status(400).json({ error: detail });
  return undefined;
}

// Where a request came from, as well as it can be known: `req.ip` is the client
// address as Express was told to see it, which is the same question `TRUST_PROXY`
// answers, answered once rather than twice. It is used to slow down guessing and
// for nothing that a wrong answer would let anybody through.
export function sourceAddress(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}
