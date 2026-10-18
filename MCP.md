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

With an API key instead of Cloudflare — minted in the web app under **Agents**,
see the next section — the header is this app's own:

```json
{
  "mcpServers": {
    "notes": {
      "type": "http",
      "url": "https://notes.example.com/mcp",
      "headers": { "Authorization": "Bearer ${NOTES_API_KEY}" }
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
- **Agents: this app's own API key.** Nothing outside the app has to be in the
  loop. In the web app, open **Agents** (the key button in the sidebar) and mint a
  key per machine, with a name of your own choosing. Send it as:

  ```
  Authorization: Bearer notes_<the key, shown once>
  ```

  A key acts as the **whole account** — every note you can see, including making
  them public and deleting them — which is what the Access credential it replaces
  does too. Everything the app keeps about a key is a hash of it (`keys.json`,
  beside `notes.json`; `API_KEYS_DATA_FILE` moves it), so a copied data file hands
  over no working credentials. The plaintext is shown once, at creation; the list
  keeps a name and the last few characters so you can tell them apart.

  Revoking is immediate: the key stops working on the next request, and any agent
  already connected with it is hung up on. A key cannot mint, list or rename keys —
  a credential that could hand out credentials would outlive its own revocation —
  and it cannot manage another one, either: `GET/POST/DELETE /api/keys` answers
  `403` when the caller arrived with a key. Up to
  `MAX_KEYS_PER_ACCOUNT = 20` per account.

  Other people are told that _an agent_ is at work in a note, and never which key:
  a name you chose for your own list is never sent to anyone else.

- **Agents: a Cloudflare Access service token.** An alternative to the key above,
  for a deployment that already has Access and would rather Cloudflare hold the
  secret: this app stores no secret of its own, and rotates nothing. In the Zero
  Trust dashboard, create a service token and add it to the Access policy for the
  notes hostname with the **Service Auth** rule — without that rule Access answers
  the agent with a login page instead of forwarding the request. Then an agent
  sends both headers to `https://<your-notes-host>/mcp`:

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

- **Local development (`DEV_USERS=1`).** With the opt-in flag set, no
  credential means the app's dev identity is used; send
  `x-dev-user-email: someone@example.com` to act as a specific user, which is
  how the e2e suite drives two identities. The flag is explicit rather than
  "not production" so a deployment that forgets its environment fails closed:
  without it, an identity header is ignored and every anonymous request gets a
  `401`.

### Without Cloudflare Access

Access is the easy way in — nobody has a password to steal, and this app keeps no
secret — but it is not required. A deployment on a LAN, or on any host without a
Zero Trust policy in front of it, runs on this app's own credentials: an API key
per agent, as above, and a password per person (see the next section). What Access
still has to do is protect _people_: with the endpoint reachable from the internet,
an unprotected `/api` is an unprotected account, so a person signing in over Access
plus agents on API keys is the shape most deployments want.

Either way the rule is the same, because it is the same code: credentials are
verified by signature or by hash, never by which network the request came from. An
`cf-access-jwt-assertion` header that reaches the origin without Cloudflare's
signature behind it is not an identity, it is a 401.

Two settings decide what the app believes about the wires, and both answer the
safest thing when they are left alone:

- **`CORS_ALLOW_ORIGINS`** — unset, which means the API answers no cross-origin
  browser request at all. Every deployment this app has serves the client, the
  REST API, the live channel and `/mcp` from one origin — Vite proxies all four in
  development — so nothing needs it. It exists for a browser-based MCP client on
  another port: name that origin and the inspector works. Agents that are not
  browsers never needed it; CORS is a rule browsers enforce, and it has never
  stopped a terminal. `*` is not accepted, and credentials are refused whatever is
  allow-listed.
- **`TRUST_PROXY`** — unset, which means `X-Forwarded-For` and `X-Forwarded-Proto`
  are ignored, because a request that arrives directly can claim anything. Set it
  to the number of hops in front of the app (`1` for Caddy, Traefik or nginx, `2`
  for a tunnel and a proxy), or to the addresses worth believing. Until it is set,
  an app behind a proxy believes it is plain HTTP — which matters as soon as the
  app must decide whether a cookie may be marked `Secure`.

The boot line prints both, so a deployment that has one wrong hears it once, out
loud, rather than finding out through a browser.

## Passwords, for people

An account here **is** an email address — the same address a note is owned by — so
an agent and a person reach the same notes however they arrived. Accounts are made on
the command line, because a self-hosted notes app has no mail server to check an
address with, and a signup form on a private installation is a worse version of the
policy Access already gave it:

```
npm run accounts -w server -- add alice@example.com
npm run accounts -w server -- list
```

That prints a one-time password; change it under the account menu. Inside a
container: `docker compose exec notes node server/dist/cli/accounts.js add …`. A
running app notices the file within a couple of seconds, so there is nothing to
restart — and `passwd`/`remove` end the account's sign-ins along with it.

Then the app itself asks for that password, and remembers the browser with a
session cookie:

- **Opaque, not a JWT.** The cookie holds a random token and the server keeps the
  list, which is what makes signing out, revoking a device, changing a password and
  closing a browser tab all mean the same word: ended. A self-contained token could
  only be waited out, and would need signing keys of this app's own to mint.
- **`__Host-notes_session` over HTTPS**, and the plain `notes_session` over http,
  because the strong name requires `Secure` and a LAN deployment has no HTTPS to
  have. Either way: `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`.
- **Sliding, for 30 days of last use** (`SESSION_HOURS`), and a sign-in from the same
  browser replaces the one it already had rather than adding a second.
- **Only the hashes of both are stored** — `accounts.json` and `sessions.json`
  beside `notes.json` — so a copied data directory yields no working credential.
- Sessions are listed under **Account**, per device, each with a sign-out; that is
  also where a password is changed, which signs every device out.

The app never answers "no account by that address" and "wrong password"
differently, and it starts waiting after five failures from one address on one
account.

## Tools

| Tool                  | What it does                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `whoami`              | Which user this connection acts as, and how many notes that can see                               |
| `list_notes`          | Titles, ids, visibility and versions, newest first (`limit`/`offset`/`visibility`)                |
| `read_note`           | One note as numbered lines, a page at a time (`from`/`lines`)                                     |
| `search_notes`        | Matching lines inside visible notes, plain text or regex, with context lines                      |
| `create_note`         | New note from markdown (`title`, `visibility`)                                                    |
| `type_in_note`        | Types at the agent's caret: words, one word, pasted text, a link                                  |
| `update_note`         | Replace a whole note                                                                              |
| `append_to_note`      | Add markdown to the end, optionally under a new `##` heading                                      |
| `start_todo_list`     | Turn a note into a to-do list, or start one (`name`, `content`)                                   |
| `replace_in_note`     | Find/replace inside a note as plain text (`regex`) or a pattern, single match unless `all` is set |
| `set_note_visibility` | Private ↔ public (owner only)                                                                     |
| `delete_note`         | Delete permanently (owner only)                                                                   |

Permissions are the app's, enforced per call: everyone who can see a note may
edit it, only the owner may change visibility or delete it. Editing a public
note fires the same browser-push notifications a web edit does.

Notes are markdown, the same documents the web editor writes.

## Reading and typing where a person would

`read_note` prints a note the way an editor prints a file - `3 | - buy milk` -
and those numbers are addresses: `line`, `column`, `after` and `before` take them
back. A long note arrives a page at a time, and the answer says which lines
follow. The numbers are not part of the text, so an agent quoting words to
`replace_in_note` quotes what comes after the gutter.

That shape exists so writes can be small. `type_in_note` types at a caret instead
of restating a document: `after: "buy milk"` with `text: " and eggs"` puts those
words there, a newline in `text` is the Enter key (a list grows an item with the
same marker, prose gets a paragraph), and a backspace deletes. It cannot rewrite
the lines around it, which is the point: an agent cannot break a paragraph it
meant to leave alone. And a note that already says exactly that is not saved
again just to burn a version.

Text the agent was handed - `word`, `paste` - is content, not formatting. A
markdown link inside it is written out as its words and its address rather than
becoming clickable, so words from an untrusted page cannot put a lie in front of
a person; a link that is meant to be one arrives through `link`, whose address is
checked (`http`, `https`, `mailto`).

## Versions, not overwrites

Every note carries a `version`, printed by every read, list and search. A write
that passes the version it read fails with `Conflict` and returns the note's
current text if somebody else changed it in the meantime, so an agent re-applies
its change instead of clobbering it. Omitting the version writes against whatever
is newest — fine for a note nobody else is in, risky in a shared one.

`replace_in_note` additionally refuses a find that matches several times (unless
`all: true`) and one that matches nothing, so a partial edit never lands. A find
without `regex` is matched as written — the brackets of a checkbox are brackets,
and a `$` in a replacement is a dollar sign — so ticking a box by quoting its own
line is an exact edit, not a pattern that happens to look like one.

A refused local edit is cheap to retry: `type_in_note`, `append_to_note` and
`replace_in_note` build their text from the note as it stands when the call runs,
so sending the same call again without a version applies the change to the new
text. A whole-document `update_note` deliberately gets no such advice - re-sending
it would overwrite whatever the other person wrote.

## To-do lists

A note whose first line is `# Todo · name` is a rolling to-do list: open items at
the top, and everything ever ticked filed under a `## YYYY-MM-DD` heading for the
day it was ticked.

Ticking a box is the whole edit an agent makes to that shape — change `- [ ]` to
`- [x]` and nothing else. The app files the item for you, as the write is saved:
it moves under the heading for its day, and emptying a box brings it back out of
the day it was filed in. So do not move items between day headings yourself, do
not write those headings, and do not be surprised when a read shows your edit
where you did not leave it — that is the list tidying itself. A note that arrives
with several ticked items has them all filed by the same rule, and a note without
the `Todo` line is never touched.

"Today" is the day on the app's own clock, the server's local date — the same
calendar the person using the app is on, which is what the web editor files under
too.

An ordinary note becomes a list through `start_todo_list`: its lines become open
items and its first line becomes the `# Todo · name` heading. Give it the `id` of
a note you can already see, or none to make the note as well. What a list is
called belongs to the person who owns it — launching a list again changes nothing,
rather than renaming it.

A write that arrives with a `## date` heading the note did not have is saved all
the same, and answered with a line saying the list writes those itself.

## Being seen as an agent

An agent edits the same notes as the person it acts as, but it should not look
like that person typing. When a connection is authenticated with a machine
credential (a pinned service token, or the `x-dev-agent` dev identity), this app
marks it as an agent and surfaces that everywhere people look:

- **Push notifications** say `Updated by you@example.com's agent`, not
  `Updated by you@example.com`. And because that edit was _not_ the person
  typing, it does **not** count as their own change — they are still notified
  when their agent edits a shared note.
- **Live presence** — the header chip and the remote caret — shows an agent
  as a peer **distinct from the person's own tab**, even though both act as the
  same email. Its caret sits where it is working: reading leaves it at the end of
  what was read, typing moves it to the words just typed, and the chip says
  `is viewing` or `is editing`. An agent has no cursor to hold a place with, so
  the server remembers one per note for the life of the session, and follows it
  along when the note changes underneath it.
- An agent leaves a note by going quiet: the chip falls back to `is viewing` a
  little after its last keystroke, and the caret goes a while after that. Closing
  the connection takes its carets out of every note at once.
- `whoami` reports `Acting as you@example.com (AI agent)`.

The label is always rendered by this app from the account email plus a boolean
"is an agent", never from a name the agent chose for itself — so an agent cannot
present itself as a person or as a different account.

## Resources

Clients that attach context instead of calling tools get the same data:

- `notes://index` — every visible note with title, id, visibility and version
- `note://{id}` — one note as markdown, whole and unnumbered: resources are
  context to attach, not a window to work from, so they carry no caret

After any change, every open session is told (`notifications/resources/updated`
plus a resource list change), so an agent that keeps the index attached learns
when a note goes stale.

## Settings

| Variable               | Default   | Purpose                                                 |
| ---------------------- | --------- | ------------------------------------------------------- |
| `MCP_PATH`             | `/mcp`    | Path the endpoint is mounted on                         |
| `MCP_MAX_SESSIONS`     | `25`      | Concurrent sessions before `initialize` gets a `503`    |
| `MCP_IDLE_TIMEOUT_MS`  | `1800000` | Close sessions that have been quiet for this long       |
| `MCP_BODY_LIMIT`       | `4mb`     | Largest JSON-RPC request body                           |
| `MCP_AGENT_EMAIL`      | unset     | Account a machine credential acts as                    |
| `MCP_SERVICE_TOKEN_ID` | unset     | Service token Client ID the mapping accepts             |
| `API_KEYS_DATA_FILE`   | unset     | Where API keys live — hashes only                       |
| `ACCOUNTS_DATA_FILE`   | unset     | Where password accounts live — hashes only              |
| `SESSIONS_DATA_FILE`   | unset     | Where sign-ins live — hashes only                       |
| `SESSION_HOURS`        | `720`     | How long a sign-in lasts unused                         |
| `ACCESS_NOT_VERIFIED`  | unset     | Dev only: trust Access assertions without checking them |
| `CORS_ALLOW_ORIGINS`   | unset     | Other browser origins allowed to call the API           |
| `TRUST_PROXY`          | unset     | Hops of X-Forwarded-* to believe, e.g. 1                |

Sessions are in memory: restarting the server drops them and clients re-run the
`initialize` handshake. Sessions whose client disappears are closed by the idle
sweep.

## Layout

```
server/src/auth.ts          the credential chain: Access JWT, API key, session, dev identity
server/src/credentials.ts   reading credentials off a request: bearers, cookies, and their providers
server/src/signIn.ts        sign in, sign out, sessions, and changing a password
server/src/accounts.ts      the accounts a person is stored as
server/src/sessions.ts      the sign-ins a browser is remembered by
server/src/password.ts      scrypt hashing, with the cost carried in the record
server/src/guard.ts         counting the guesses, and starting to wait
server/src/cli/accounts.ts  the command line that makes an account
server/src/keys.ts          API keys: minted by a person, kept as a hash
server/src/mcp/http.ts        routes, session handshake, session lifecycle
server/src/mcp/auth.ts        identity: Access JWT, bearer token, service-token mapping
server/src/mcp/server.ts      one McpServer per session + client instructions
server/src/mcp/tools.ts       the tools, on the same store module as the REST API
server/src/mcp/text.ts        caret maths and keystrokes, in plain markdown
server/src/mcp/cursor.ts      where each session's caret is, and saying so
server/src/mcp/resources.ts   notes://index and note://{id}
server/src/mcp/hub.ts         live session registry and change notifications
server/src/mcp/format.ts      how a note is rendered as text
```

Covered by `e2e/mcp.spec.ts`, `e2e/mcp-identity.spec.ts` and
`e2e/agent-cursor.spec.ts` (`npm run test:e2e`), which drive the endpoint with a
real MCP client over two identities while a browser watches the caret.
