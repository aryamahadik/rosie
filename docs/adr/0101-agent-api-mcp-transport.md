# ADR-101: Agent API (K-20) transport and sign-in for outside assistants

- Status: proposed (spike T-785, for K-20 v1's freeze, T-029)
- Date: 2026-11-07
- Owner: architect. Decides: the CTO.
- How it was made: a research agent with web access read the pages in the sources list for the architect (DL-064, time box 2 hours; it used about 25 minutes); the lead wrote this record from its text report (DL-063). The fetch tool summarizes each page through a small model, so quoted lines are as returned; re-read the vendor pages at the freeze.

## Context

- K-20 (`ops/plan/02-contracts.md` lines 450 to 467) puts one set of calls behind two doors, MCP tools and REST, with scoped tokens. CQ-13 (`ops/QUESTIONS.md` line 171) sets the default scopes: one token per AI client; an unbound token may search, read times and prices, and save a time; a token bound to a customer may also book and read that customer's bookings.
- K-20's "Spike before freeze" asks for the MCP remote transport and the sign-in it expects, as ChatGPT, Claude and Gemini use it, served from a Worker.

## Findings

1. **The current MCP revision is 2026-07-28, and it changed the transport** (sources 1 to 3, the Transports, Streamable HTTP, Versioning and Changelog sections).
   - There is no `initialize` handshake: every request carries its protocol version and client capabilities in `_meta`.
   - There are no protocol sessions, no `Mcp-Session-Id` header and no GET stream endpoint; SSE is optional and scoped to one request.
   - Servers must implement a `server/discover` call.
   - The pages show the version string "2026-07-28" but no release date or "final" label: whether it is final is unknown.
2. **The previous revision, 2025-11-25, used the older Streamable HTTP shape** (source 2): `initialize`, an optional `Mcp-Session-Id`, GET for a server stream and DELETE to end a session. Streamable HTTP began in 2025-03-26.
3. **The old HTTP+SSE transport (2024-11-05) is deprecated** (sources 2 and 3): deprecated since 2025-03-26; 2026-07-28 classes it as Deprecated, says new implementations should not adopt it, and says it may be removed later. Claude still supports it, "being deprecated in favor of Streamable HTTP" (source 7). OpenAI's MCP page shows only an SSE example (source 6). So outside assistants may still need one or both older shapes.
4. **Authorization, revision 2026-07-28** (source 4, the Authorization section). Optional in the spec; a server over HTTP that uses it should follow this profile:
   - The MCP server is an OAuth 2.1 resource server (the spec cites OAuth 2.1 draft-13).
   - It must serve Protected Resource Metadata (RFC 9728); clients use it to find the authorization server.
   - The authorization server must offer RFC 8414 metadata or OpenID Connect Discovery; clients must support both.
   - Client ID Metadata Documents: SHOULD be supported by authorization servers and clients. Dynamic Client Registration (RFC 7591): MAY, marked deprecated in 2026-07-28 and kept for compatibility.
   - Resource indicators (RFC 8707): clients must send `resource` in the authorization and token requests. The server must check that a token was issued for it as audience, and must not accept or pass on other tokens.
   - `Authorization: Bearer` on every request; a token in the URL query is forbidden.
   - Scopes: a 401 should carry `scope` in `WWW-Authenticate`; too little scope gives a 403 with `error="insufficient_scope"` and the scopes needed, and the client asks again.
   - PKCE appears only as a diagram step in the text read: expected, but check the OAuth 2.1 draft (unknown here).
5. **What each assistant documents.**
   - ChatGPT (source 6, no date shown): recommends OAuth with Client ID Metadata Documents and supports Dynamic Client Registration "when configured"; a custom server is added with its URL and auth details; the page gives only an SSE example (URL ending `/sse/`) and does not mention Streamable HTTP or bearer headers; deep research wants read-only `search` and `fetch` tools.
   - Claude (source 7, no date shown): recommends Streamable HTTP and still supports HTTP+SSE; OAuth follows the 2025-03-26, 2025-06-18 and 2025-11-25 authorization specs (2026-07-28 not listed); Claude registers itself by Dynamic Client Registration; redirect URI `https://claude.ai/api/mcp/auth_callback`, plus a loopback address for Claude Code; Claude refreshes tokens; an organization Owner may instead enter a static header credential, or no auth; about 150,000 characters per result and a 240 s tool timeout on claude.ai.
   - Gemini: the Gemini app and the Gemini API document nothing found (unknown). Gemini CLI (source 8, last updated Oct 6 2026) supports stdio, SSE and Streamable HTTP (`httpUrl` for HTTP, `url` for SSE); for remote servers it uses OAuth 2.0 (detects a 401, discovers endpoints, registers dynamically "if supported") or custom headers such as a bearer token. A banner says Gemini CLI was replaced by Antigravity CLI on June 18 2026 for unpaid and Google One users.
6. **On a Worker** (sources 9 to 11, last updated Oct 27 2026).
   - Cloudflare's pattern is `createMcpHandler` from the Agents SDK: stateless, a fresh `McpServer` per request, no Durable Object. Durable data goes in D1, KV, R2 or a Durable Object, reached by an authenticated handle, not a session id.
   - `McpAgent` (Durable Object based) is marked deprecated, with a migration guide to MCP SDK v2.
   - The default route is `/mcp`. A `legacy` option (default `"stateless"`) serves older clients; GET and DELETE return 405. Cloudflare's guide covers Streamable HTTP only.
   - `@cloudflare/workers-oauth-provider`: `OAuthAuthorizationServer` provides `/authorize` and the token endpoint, with grants in KV; `OAuthResourceServer` wraps the handler, serves protected resource metadata, returns a 401 pointing at it, binds each token to one resource and rejects tokens for other resources.
   - `requiredScopes` is advertised but not enforced: the handler checks `ctx.auth.scope` and returns `insufficientScope()`. Client ID Metadata Documents need the `global_fetch_strictly_public` flag; DCR is optional. `props` set when authorization completes reach each call as `ctx.props`; a bring-your-own sign-in route calls `completeAuthorization()`. CORS is not authentication.

## Decision (proposed)

1. **Transport.** Streamable HTTP at one Worker route, `https://<host>/mcp`, with `createMcpHandler`, stateless, one fresh server per request. Serve the 2026-07-28 shape first, and keep the library's default `legacy: "stateless"` mode so a client that sends `initialize` (2025-11-25 and earlier) is still served, without sessions. Do not build the old HTTP+SSE transport now; add it only if the CTO finds ChatGPT needs it (open point 1). Check the `Origin` header on every request (403 if invalid) and set `allowedHostnames` for Rosie's host.
2. **State.** None in the protocol. K-20's saved-time id, status and booking number are ordinary tool arguments and results, looked up in PostgreSQL under the token's business scope, as K-20 already does ("server-minted handles").
3. **Sign-in for scoped tokens.**
   - Rosie is an OAuth 2.1 resource server and runs its own authorization server with `workers-oauth-provider`. Tokens are audience-bound to the `/mcp` URL (RFC 8707 `resource`); the same tokens, as `Authorization: Bearer`, open the REST door on the same Worker.
   - Client identity: accept Client ID Metadata Documents first (ChatGPT recommends them) and keep Dynamic Client Registration on, because Claude registers that way; limit registration by an approval or rate rule, since open DCR lets any client self-register.
   - Scope names, proposed from CQ-13: `rosie.search`, `rosie.times`, `rosie.save` for the unbound token; `rosie.book` and `rosie.read_bookings` for the bound one. `scopes_supported` lists the unbound three.
   - Binding rides the authorization step: when a client asks for a bound scope, `/authorize` shows Rosie's binding page; the customer gives their mobile and gets the code by C9's route (texting Rosie from that mobile, or email) and types it back (K-20 "Bind", Q-09); then `completeAuthorization()` issues a token with the bound scopes and the customer id in `props`.
   - An unbound token that calls `book` gets 403 `insufficient_scope` with `scope="rosie.book"` and the metadata URL, and the client runs the bind step. The handler checks scopes itself.
   - One token per AI client (CQ-13); saved-time limits (2 per token per business) key on the token's grant id. Tokens carry no card data, street address or check-in code (K-20 "Every answer").
4. **REST door.** Same Worker, same tokens and scopes, same action-layer functions: K-20's "one set of calls over two transports".

## Minimal request and response

Under 2026-07-28 there is no `initialize` step: the first call can be `tools/call`, and each request carries its own metadata. The headers and request body follow the spec's own `tools/call` example (source 2). The result body is an illustration: `resultType: "complete"` is confirmed (source 3), but the `content` schema was not read, so check it against the schema before the freeze. `rosie_find_times` and its arguments are illustrative, not frozen.

Request:

```http
POST /mcp HTTP/1.1
Host: api.rosfield.com
Authorization: Bearer <access-token>
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: rosie_find_times

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "rosie_find_times",
    "arguments": { "service_id": "svc_demo_01", "day": "2026-11-12" },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "ExampleClient", "version": "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

Response (the server may answer in JSON, as here, or with an SSE stream for the same request):

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resultType": "complete",
    "content": [{ "type": "text", "text": "3 times on Nov 12: 9:00, 11:30, 2:00. Total $120. Free cancel until Nov 11 9:00." }],
    "structuredContent": { "times": ["09:00", "11:30", "14:00"], "total": "120.00" }
  }
}
```

No token gives a 401 with `WWW-Authenticate: Bearer resource_metadata="https://api.rosfield.com/.well-known/oauth-protected-resource", scope="rosie.times"`; too little scope gives a 403 with `error="insufficient_scope"`. The host `api.rosfield.com` is a placeholder (open point 8).

Older clients (2025-11-25) first POST `initialize`, then `notifications/initialized`, then call tools, carrying `Mcp-Session-Id` if the server issued one; in stateless legacy mode Rosie issues none. The exact headers of that flow were not re-read in this spike (unknown).

## Consequences

- No Durable Object is needed for MCP; each request costs a fresh server object and a token check. Rosie's state stays in PostgreSQL.
- Rosie owns an OAuth authorization server (a KV namespace for grants, the consent and binding page, a client registry): new surface that touches consent and personal data, so the security reviewer reviews it.
- The binding page reuses C9's code route, so sign-in and the customer tie are one step.
- With no sessions in the spec, K-20's fixtures carry no session id; a fixture for the legacy `initialize` path is optional. The contract states its scope list and the minimum protocol version it serves.
- Dropped for now: the old HTTP+SSE transport and server-initiated requests (sampling, roots, elicitation); K-20 needs none.
- A vendor may change before launch: re-read the three vendor pages at the freeze (F15).

## Open points for the CTO

1. Does ChatGPT need the old HTTP+SSE transport? OpenAI's page shows only an SSE example: test with a real ChatGPT connector before the freeze (unknown).
2. Which spec versions must Rosie serve? Proposed: 2026-07-28, plus 2025-11-25 in stateless legacy mode (Claude documents up to 2025-11-25 only).
3. Gemini: do the Gemini app or API connect to remote MCP servers? Unknown; only Gemini CLI is documented, and it is being replaced by Antigravity CLI for some users.
4. Client ID Metadata Documents, Dynamic Client Registration, or both? Proposed: both, with DCR limited by an approval or rate rule.
5. Are the scope names `rosie.search`, `rosie.times`, `rosie.save`, `rosie.book` and `rosie.read_bookings` right, and does CQ-13's table map onto them?
6. Is a bound token issued only after the binding code is typed at `/authorize`, or may a client bind later through a tool call?
7. Token lifetime and refresh for AI clients? Claude refreshes tokens; the plan sets no lifetime.
8. Host and path: `/mcp` on the "test" location or its own host? `allowedHostnames` and the token audience depend on it (DL-014).
9. Is `createMcpHandler` on MCP SDK v2 stable enough? Cloudflare marks `McpAgent` deprecated, and SDK v2 and the 2026-07-28 spec are both new.
10. Does ChatGPT's `search` and `fetch` convention for deep research matter to Rosie? Only if Rosie wants to be found in that mode.
11. Static bearer tokens for REST-only partners: allowed, or OAuth only? Claude and Gemini CLI accept static headers.

## Sources

All read on Nov 7 2026.

1. MCP specification, Transports overview (the "latest" link points to revision 2026-07-28; no date shown): https://modelcontextprotocol.io/specification/latest/basic/transports
2. MCP specification, "Streamable HTTP", revision 2026-07-28 (no date shown): https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
3. MCP specification, "Versioning and Compatibility" and "Key Changes", revision 2026-07-28 (no release date shown): https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning and https://modelcontextprotocol.io/specification/2026-07-28/changelog
4. MCP specification, "Authorization", revision 2026-07-28 (no date shown): https://modelcontextprotocol.io/specification/latest/basic/authorization
5. MCP specification, revision 2025-11-25 transports: named by source 2 and cited through it; not opened: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
6. OpenAI, MCP docs page (the old URL https://platform.openai.com/docs/mcp redirects here; no date shown): https://developers.openai.com/api/docs/mcp
7. Anthropic, "Build an MCP server for Claude" (no date shown): https://claude.com/docs/connectors/building.md
8. Gemini CLI, MCP servers (last updated Oct 6 2026): https://geminicli.com/docs/tools/mcp-server
9. Cloudflare, "Building a Remote MCP Server on Cloudflare" (last updated Oct 27 2026): https://developers.cloudflare.com/agents/guides/remote-mcp-server/
10. Cloudflare, `createMcpHandler` API reference (last updated Oct 27 2026): https://developers.cloudflare.com/agents/api-reference/mcp-handler-api/
11. Cloudflare, MCP authorization and the OAuth provider library (last updated Oct 27 2026): https://developers.cloudflare.com/agents/model-context-protocol/authorization/
12. Local: `ops/plan/02-contracts.md` (K-20, lines 450 to 467) and `ops/QUESTIONS.md` (CQ-13, line 171).

Not cross-checked against the raw pages or the GitHub repositories: source 6 and Cloudflare's statements on `McpAgent` and the OAuth library.
