# Notes

Markdown notes that sync as they are typed, owned by an email address, and served
by one container that also speaks [MCP](MCP.md) — so an AI agent reads and writes
the _same_ notes, as the same person, while that person watches the agent's caret
move.

There is no database and no web server in front. The notes are one JSON file on a
volume, and beside it sit the password hashes, the sign-ins, the API keys and the
push subscriptions. One image runs the SPA, the REST API, the live WebSocket, web
push and `/mcp`, on one origin; the Dockerfile is multi-stage (the builder needs
Vite, TypeScript and Tailwind, the runtime needs Express) and multi-arch, so it
builds natively on a Pi as easily as on a laptop.

## Run it

```bash
docker compose up -d --build      # http://<host>:4000
```

That is the whole deployment. An empty installation has nobody in it, which is why
the first person is made on the command line rather than at a signup form — a
self-hosted notes app has no mail server to verify an address with, and a signup
form on a private installation is a worse version of the door you already chose:

```bash
docker compose exec notes node server/dist/cli/accounts.js add you@example.com
```

```
Created you@example.com.
Sign in with this password — it is not stored anywhere else:
  kxxn-gajg-6kc2
```

A running app notices the new account within a couple of seconds, so there is
nothing to restart. Open the address and sign in with it; **Account** is then where
the password gets changed, where the other sign-ins are listed per device, and
where **Agents** mints the API keys an agent uses.

The boot line says what the app believes about the wires it is sitting on, so a
deployment with one setting wrong hears it once rather than finding out through a
browser:

```
Notes API listening on http://localhost:4000
  browsers: same-origin only; proxy: not trusted (set TRUST_PROXY behind a reverse proxy)
  access: not configured — set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD (an Access assertion gets a 401)
```

## Who gets in

The chain is the same code everywhere, and it is the same rule in every shape:
credentials are verified by signature or by hash, **never** by which network the
request came from. A `cf-access-jwt-assertion` header that arrives without
Cloudflare's signature behind it is not an identity, it is a 401.

| Shape                                    | People             | Agents                    |
| ---------------------------------------- | ------------------ | ------------------------- |
| Behind Cloudflare Access                 | Access (SSO)       | API key, or service token |
| This app alone, on a LAN or a VPS        | password + session | API key                   |
| This app alone, no humans in the browser | —                  | API key                   |

- **Access for people, keys for agents** is the shape most deployments want:
  nobody has a password to steal, and this app keeps no secret of its own. It
  still needs the app's own [API keys](MCP.md#authentication) for agents, because
  a service token has to be pinned to an account here anyway. Set
  `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` — there is no default, because a
  team domain and an audience are somebody's, and an app that inherited them from
  a repository would be checking its logins against a stranger's Access. Unset,
  an Access assertion is worth a 401, and the boot line says so.
- **Passwords** are the app's own door: [scrypt](MCP.md#passwords-for-people)
  hashes, opaque session cookies, revocation that actually revokes, and no answer
  that distinguishes a wrong password from an unknown address. Nothing about it
  needs Cloudflare, and nothing about Access has to be undone to add it later —
  an account _is_ the email address a note is owned by, so a person who arrives by
  password reaches exactly the notes they would have arrived at through Access.
- **Keys alone** is a deployment where only agents come: mint one on the CLI
  along with an account and never open the app in a browser.

What the passwords do _not_ do is replace Access for an internet-facing host. With
the endpoint reachable from the open internet, an unprotected `/api` is an
unprotected account; the app will throttle guesses, but that is a fallback, not a
perimeter.

## TLS, and what it changes

Publishing port 4000 on a LAN and typing `http://box.local:4000` is a complete,
working installation. The one thing plain HTTP costs is the stronger cookie name: a
session is stored as `__Host-notes_session` where the request arrived over HTTPS and
as `notes_session` where it did not, because the `__Host-` prefix requires the
`Secure` attribute, and a box with no certificate cannot honestly set one.

So the moment a reverse proxy arrives, say so — `TRUST_PROXY` is the number of
hops whose `X-Forwarded-*` headers are worth believing (`1` for Caddy, Traefik or
nginx on the same host; `2` for a tunnel plus a proxy), or a list of addresses:

```yaml
environment:
  TRUST_PROXY: "1"
```

Unset, the app believes it is plain HTTP — which is the truth when it is, and the
safe answer when it is not, because a LAN app that believes `X-Forwarded-Proto`
lets any passing request decide whether its own cookies are `Secure`.

## The data directory

Everything the app remembers is in `/data`, and `/data` is a named volume
(`notes_notes-data`):

| File            | Holds                                                      |
| --------------- | ---------------------------------------------------------- |
| `notes.json`    | the notes: markdown, owner, version                        |
| `accounts.json` | accounts — email, name, and a **hash** of each password    |
| `sessions.json` | **hashes** of the outstanding session cookies, with device |
| `keys.json`     | **hashes** of the API keys, with name and last characters  |
| `push.json`     | the VAPID keys (generated on first boot) and subscriptions |

Only hashes, so a copied or leaked directory yields no working credential — but it
does yield every note, so treat the backup as the thing it is. Back it up:

```bash
docker run --rm -v notes_notes-data:/data -v "$PWD:/backup" \
  alpine:latest tar czf /backup/notes-data.tgz -C /data .
```

and restore into a volume the same way (`tar xzf /backup/notes-data.tgz -C /data`,
`-v "$PWD:/backup:ro"`). Stop the app first, or accept that a running server has
its own copy of the file in memory and will write it back over yours.

## Agents

Point any streamable-HTTP MCP client at `https://<your-notes-host>/mcp` with
`Authorization: Bearer notes_<key>`. [`MCP.md`](MCP.md) is the whole contract — the
tools, reading and typing where a person would see it, versions rather than
overwrites, to-do lists, resources, what an agent is told about itself, and the
settings that govern sessions.

## Settings

For the credential and MCP knobs, the table in
[`MCP.md`](MCP.md#settings). These are the ones a deployment sets:

| Variable                | Default                         | Purpose                                                                |
| ----------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| `PORT`                  | `4000`                          | Port the API listens on, inside the container                          |
| `NODE_ENV`              | —                               | `production`: the client bundle is served, and dev escapes are refused |
| `NOTES_DATA_FILE`       | `/data/notes.json` in the image | Where the notes live; the file above hangs off this directory          |
| `CF_ACCESS_TEAM_DOMAIN` | unset                           | Your Access team's `*.cloudflareaccess.com`                            |
| `CF_ACCESS_AUD`         | unset                           | The Access application's audience; without both, Access gets a 401     |
| `TRUST_PROXY`           | unset                           | Hops of `X-Forwarded-*` to believe                                     |
| `CORS_ALLOW_ORIGINS`    | unset                           | Other browser origins allowed to call the API (`*` is refused)         |

## Development

```bash
npm install
npm run dev            # http://localhost:5173
```

The dev server runs the API on 4000 with `DEV_USERS=1` and proxies `/api`, `/ws`
and `/mcp` to it, so there is no door in development at all: no credential means
the dev identity (`dev@localhost`), and `x-dev-user-email: someone@example.com`
means somebody else. That flag is what makes an identity header a claim instead of
a proof, which is why it is opt-in and why nothing else about it is inferred from
"not production".

```bash
npm run check          # lint, format, typecheck, 160 unit tests
npm run test:e2e       # Playwright: two browsers and an MCP client on one note
npm run build          # what the image builds
npm run accounts -w server -- list     # accounts, from your shell rather than the container
```

The e2e suite starts its own server on its own port from an empty store — and
`e2e/signin.spec.ts` starts one _without_ `DEV_USERS`, so that it is testing a
locked door rather than standing in front of an open one.

## Layout

```
server/        Express app: REST API, MCP endpoint, live sync, push, credentials
  src/mcp/     the MCP server: tools, resources, sessions, cursors
  src/cli/     the accounts command line
client/        React SPA: editor, live cursors, sign-in, account and agent panels
shared/        note shapes, todo parsing, and the three-way merge both sides use
e2e/           Playwright specs
Dockerfile     one image: build stage and runtime stage
```

The [MCP server documentation](MCP.md) carries the module-by-module list, the
authentication design, and how an agent's edits are shown to a person.
