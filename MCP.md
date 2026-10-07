# MCP server

The Notes app serves a [Model Context Protocol](https://modelcontextprotocol.io)
endpoint over **streamable HTTP**, so an AI agent can read and write the same
notes the web app shows — as the person it is authenticated as.

It is mounted inside the app itself (`server/src/mcp/`), on the same origin as
the REST API:

| Endpoint      | Transport                                |
| ------------- | ---------------------------------------- |
| `POST /mcp`   | JSON-RPC; `initialize` opens a session   |
| `GET /mcp`    | SSE stream for server-initiated messages |
| `DELETE /mcp` | closes the session                       |

Because it lives in the app, an agent needs no second deployment: point it at
`https://<your-notes-host>/mcp`. In development the Vite dev server proxies
`/mcp` to the API, so `http://localhost:5173/mcp` works too.

## Connecting

Any streamable-HTTP MCP client works. With `mcp-remote` (a stdio→HTTP bridge,
needed by clients that only speak stdio):

```json
{
  "mcpServers": {
    "notes": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://notes.example.com/mcp",
        "--header",
        "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}",
        "--header",
        "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}"
      ]
    }
  }
}
```

Clients with native streamable-HTTP support (Claude Desktop/Agent SDK, Cursor,
pi, …) take the URL directly plus whatever header their auth needs:

```json
{
  "mcpServers": {
    "notes": {
      "type": "http",
      "url": "https://notes.example.com/mcp",
      "headers": {
        "CF-Access-Client-Id": "${CF_ACCESS_CLIENT_ID}",
        "CF-Access-Client-Secret": "${CF_ACCESS_CLIENT_SECRET}"
      }
    }
  }
}
```

## Authentication

The MCP endpoint uses the app's identity, so an agent can only ever see and
change what that identity can. Notes are owned by an email address, so an agent
must resolve to one.

- **Behind Cloudflare Access (production).** Every request carries a verified
  Access JWT, either in the `cf-access-jwt-assertion` header Access sets, or in
  `Authorization: Bearer <jwt>` for clients that cannot set that header. The
  token's `email` claim becomes the acting user.
- **Agents: a Cloudflare Access service token.** This is the one supported
  machine credential, and it is Cloudflare's, not ours. In the Zero Trust
  dashboard, create a service token and add it to the Access policy for the
  notes hostname with the **Service Auth** rule — without that rule Access
  answers the agent with a login page instead of forwarding the request. Then
  send both headers to `https://<your-notes-host>/mcp`:

  ```
  CF-Access-Client-Id: <client id>
  CF-Access-Client-Secret: <client secret>
  ```

  Access validates them and stamps the request with an application token, so
  the agent never handles a JWT and this app never stores a secret. The minted
  token identifies itself by `common_name` (the Client ID) and carries **no
  email** — while every note is owned by an email — so the pairing has to be
  named here:

  ```env
  MCP_AGENT_EMAIL=agent@example.com                 # account to act as
  MCP_SERVICE_TOKEN_ID=<client id>                  # the token allowed to be it
  ```

  Both are required, and that is the point: an unpinned `common_name` would
  mean "any service token this organization issues may be this account", which
  widens by itself the day a second token is created. Nothing is granted while
  either is unset — a service token then gets a `401`.

  Two consequences worth knowing. The agent reaches the app the way any client
  does, through Access, so it is usable from wherever the agent runs and needs
  no second credential when the app moves host — and, the same coin, agent
  access goes down with Cloudflare, not with the local network.

- **Local development (`NODE_ENV !== production`).** No credential means the
  app's dev identity is used; send `x-dev-user-email: someone@example.com` to
  act as a specific user, which is how the e2e suite drives two identities.

## Tools

| Tool                  | What it does                                                                       |
| --------------------- | ---------------------------------------------------------------------------------- |
| `whoami`              | Which user this connection acts as, and how many notes that can see                |
| `list_notes`          | Titles, ids, visibility and versions, newest first (`limit`/`offset`/`visibility`) |
| `read_note`           | One note in full: markdown plus metadata                                           |
| `search_notes`        | Matching lines inside visible notes, plain text or regex, with context lines       |
| `create_note`         | New note from markdown (`title`, `visibility`)                                     |
| `update_note`         | Replace a whole note                                                               |
| `append_to_note`      | Add markdown to the end, optionally under a new `##` heading                       |
| `replace_in_note`     | Find/replace inside a note, single match unless `all` is set                       |
| `set_note_visibility` | Private ↔ public (owner only)                                                      |
| `delete_note`         | Delete permanently (owner only)                                                    |
| `list_stickers`       | The shared sticker library                                                         |

Permissions are the app's, enforced per call: everyone who can see a note may
edit it, only the owner may change visibility or delete it. Editing a public
note fires the same browser-push notifications a web edit does.

Notes are markdown, and stickers are inline shortcodes that round-trip through
the editor: `[sticker id="…" name="…"]`.

## Versions, not overwrites

Every note carries a `version`, printed by every read, list and search. A write
that passes the version it read fails with `Conflict` and returns the note's
current text if somebody else changed it in the meantime, so an agent re-applies
its change instead of clobbering it. Omitting the version writes against whatever
is newest — fine for a note nobody else is in, risky in a shared one.

`replace_in_note` additionally refuses a find that matches several times (unless
`all: true`) and one that matches nothing, so a partial edit never lands.

## Resources

Clients that attach context instead of calling tools get the same data:

- `notes://index` — every visible note with title, id, visibility and version
- `note://{id}` — one note as markdown

After any change, every open session is told (`notifications/resources/updated`
plus a resource list change), so an agent that keeps the index attached learns
when a note goes stale.

## Settings

| Variable               | Default   | Purpose                                              |
| ---------------------- | --------- | ---------------------------------------------------- |
| `MCP_PATH`             | `/mcp`    | Path the endpoint is mounted on                      |
| `MCP_MAX_SESSIONS`     | `25`      | Concurrent sessions before `initialize` gets a `503` |
| `MCP_IDLE_TIMEOUT_MS`  | `1800000` | Close sessions that have been quiet for this long    |
| `MCP_BODY_LIMIT`       | `4mb`     | Largest JSON-RPC request body                        |
| `MCP_AGENT_EMAIL`      | unset     | Account a machine credential acts as                 |
| `MCP_SERVICE_TOKEN_ID` | unset     | Service token Client ID the mapping accepts          |

Sessions are in memory: restarting the server drops them and clients re-run the
`initialize` handshake. Sessions whose client disappears are closed by the idle
sweep.

## Layout

```
server/src/mcp/http.ts        routes, session handshake, session lifecycle
server/src/mcp/auth.ts        identity: Access JWT, bearer token, service-token mapping
server/src/mcp/server.ts      one McpServer per session + client instructions
server/src/mcp/tools.ts       the tools, on the same store module as the REST API
server/src/mcp/resources.ts   notes://index and note://{id}
server/src/mcp/hub.ts         live session registry and change notifications
server/src/mcp/format.ts      how a note is rendered as text
```

Covered by `e2e/mcp.spec.ts` (`npm run test:e2e`), which drives the endpoint with
a real MCP client over two identities.
