# TODO

Things this app knows it should do and does not.

## File a ticked item under the owner's day, not the server's

`server/src/changes.ts` files a ticked to-do item under `todoDate()` — the date
the server's own clock says — because a write carries no idea of whose calendar
it is being made on. A person's tick is unaffected: the web editor files it as it
is typed, under the day the person sees, and filing text that is already filed is
a no-op. An agent's tick is not, because that write is filed by the server alone,
so a host on UTC and a person on UTC+9 disagree about the day for the nine hours
a day that their dates differ, and the item lands on the wrong heading.

This wants to be an account setting, which is why it is here rather than fixed:

- Keep a timezone per account, learned the once a browser reports it
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`) rather than asked for.
- File under the owner's day: `fileTickedItems` is called from `createNote` and
  `updateNote`, which already hold the actor, so the change is whose zone to ask
  the store for and not new plumbing.
- Give `todoDate` that zone — `Intl.DateTimeFormat` formats the same `YYYY-MM-DD`
  the editor writes today, so nothing about the heading changes.
- The day is then the note owner's rather than the writer's: a person editing
  somebody else's list files their tick on the owner's day. That is the rule the
  UI implies, and the one worth writing down.

The specs assume it away: `e2e/todo.spec.ts` and `e2e/mcp.spec.ts` both compute
today from the test machine's clock, which is the machine the server runs on.
Once the day comes from a stored zone, they need to fix that zone rather than
inherit it — or the tests will start disagreeing with the app around midnight.

`MCP.md` says "today is the day on the app's own clock" under "To-do lists", and
should say whose clock once this is done.
