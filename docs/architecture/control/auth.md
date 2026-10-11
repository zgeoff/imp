# Auth

Every call into impd runs as a caller, and one resolver decides the caller for every route alike:
the procedures, the exec and tunnel sockets, the upload and the MCP endpoint. A caller has a scope
and the imps it may reach, and the router checks both before a handler runs. The wake proxy is the
exception: it serves an imp's own pages to anything that can reach it, and the tailnet's ACL is its
boundary ([ingress](../network/ingress.md#the-wake-proxy)). The
[tokens guide](../../guides/tokens.md) covers making tokens and rules.

## Callers

The resolver tries three sources in order: a bearer token, then the dashboard's session cookie, then
a tailnet identity. A wrong bearer token is refused outright and never falls through to the cookie
or the tailnet, so a client that sent a bad token never runs as someone else. With none of the
three, the request gets a 401.

- **The root token** is made on impd's first start and kept in a file only root reads. It has full
  scope on every imp and lives outside the database.
- **A named token** has a scope, optional imp patterns, and SSH keys bound to it. impd keeps only
  its hash and shows the secret once, and only a host-wide `manage` caller may make, change or
  remove one.
- **An SSH key** bound to a token logs in as that token. A key in the authorized-keys file gives
  `exec` on every imp, since the file is the host owner's, as the root token is.
- **A tailnet identity** reaches the API with no token, when the owner sets rules for it.
- **An exec ticket** is single use and short-lived, and opens one exec socket on one imp, as the
  caller that asked for it.
- **A move ticket** opens nothing but its one move's steps
  ([moves](../storage/moves.md#one-live-copy)).
- **An OAuth grant** works only on the public MCP route.

Removing a token ends what it carries. Its SSH keys and OAuth grants go with it, and a revocation
signal ends its live streams and closes its sockets. A grant to a broker secret is no credential: it
binds a secret to an imp ([the credential broker](../network/broker.md)).

## Scopes

Scopes nest: `read`, then `exec`, then `manage`. An access map gives every procedure the scope it
needs and what it targets: the host, an imp named in its input, a grant, or nothing. A procedure
missing from the map is refused, so a new procedure is closed until someone writes its rule. The
router checks the map before input validation and before the handler, and a refusal is `FORBIDDEN`
with a reason that says whether the scope or the imps fell short. An imp target is checked against
the caller's patterns by name, and a call that names a new imp, such as a create or a fork, needs a
pattern that covers the new name too. Some calls are host-wide whatever their input, because what
they touch is shared: tokens, secrets and grants, networks, backups and the receiving side of a
move. A scoped token can be given a list of secrets it may grant to its own imps, so an agent can
set up an imp without host-wide reach. Such a token may not fork or move an imp, because a fork
copies grants and a move carries them.

## The dashboard session

The browser never holds an API token. A login takes a token once, the root token or a named one, and
sets a session cookie that acts with that token's scope. The cookie is HttpOnly and SameSite=Strict,
and behind TLS it takes the `__Host-` prefix, so no other name under the domain, an imp's included,
can set it. Its value names the token and an expiry, signed with a key derived from the root token,
so it survives an impd restart, a new root token ends every session, and impd checks on each request
that the token still exists.

SameSite alone is not enough here. Imps serve pages on other ports of impd's own host, and a browser
counts those as the same site, so an imp's page could call the API with the owner's session. So the
API takes the cookie only from the dashboard's own origin, by `Sec-Fetch-Site` or else by an
`Origin` that names impd, and no origin means no access. The exec, tunnel and MCP routes never take
the cookie: the dashboard gets exec tickets over the API instead. The proxy strips both cookie names
from every request it forwards to an imp. An imp's server can still set cookies for the host and log
the dashboard out by flooding the jar, but it cannot read or use the session.

## Tailnet identity

With rules set, impd asks Tailscale who is behind a connection's address and gives it the first rule
that matches by user, tag or any peer; no rule means no access. The address must be the client's
own: impd asks only about addresses in Tailscale's ranges, which the base firewall drops unless they
arrive on the tailnet interface ([networking](../network/networking.md#the-base-firewall)), and the
node's own addresses are no peer, since an imp's traffic out through the node would otherwise get
the node's tags. Over the HTTPS domain, the proxy hands the client's address to the API in process,
by a one-time handle it strips from every client request.

A tailnet identity is ambient: a browser on that machine sends it with every page's requests, as it
would a cookie. So impd takes it only when the `Host` names impd itself, which defeats DNS
rebinding, and the request comes from impd's own origin or from a client that is no browser.

## OAuth

The public MCP route lets a hosted assistant that can hold no imp token and cannot reach the tailnet
sign in with OAuth. The owner adds each client, and approves each sign-in by its code with a named
token. A grant is never wider than the token that approved it or the scope the client asked for,
holds no secrets, and is checked against its token on every request, so removing the token ends
every grant it approved. Access tokens are short-lived, refresh tokens rotate on each use, and
reusing a spent refresh token revokes the grant, because only a stolen copy would be used twice. The
route takes nothing as an identity but an access token from a grant. The
[MCP guide](../../guides/mcp.md#public-route) covers the setup.
