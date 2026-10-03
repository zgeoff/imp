# HTTPS on your own domain

With `IMP_DOMAIN=imp.example.com`, every imp is at `https://<name>.imp.example.com`, and impd's own
API is at `https://imp.example.com`. Both answer on the tailnet only, except the imps you make
[public](#public-imps). impd gets one wildcard certificate from Let's Encrypt with the ACME DNS-01
challenge, renews it, and keeps the DNS records pointed at the host's tailnet IP. Without
`IMP_DOMAIN`, nothing changes: the [per-port URLs](../architecture/networking.md#urls) stay the only
tailnet URLs.

This is the recommended way to give imps names. Tailscale Services can give each imp a name instead
([per-imp names](./tailscale.md#per-imp-names)), but that needs an API credential that reaches every
service on the tailnet, and it puts each imp's name in the public certificate logs.

## Set it up

You need a domain in a Cloudflare zone and an API token for it.

1. In Cloudflare, create an API token with **Zone → Zone → Read** and **Zone → DNS → Edit**, limited
   to the zone that holds your domain.
2. Add these to the host's env file (`/etc/imp/imp-host.env`, mode 0600):

   ```sh
   IMP_DOMAIN=imp.example.com
   IMP_DNS_PROVIDER=cloudflare
   IMP_DNS_API_TOKEN=<the token>
   IMP_ACME_EMAIL=you@example.com
   ```

3. Restart the host container. impd logs its progress with an `impd: https:` prefix:

   ```text
   impd: https: imp.example.com and *.imp.example.com point at 100.101.102.103
   impd: https: asking for a certificate for imp.example.com and *.imp.example.com: there is no certificate
   impd: https: got a certificate for imp.example.com, expiring 2027-01-01T00:00:00.000Z, in 21345ms
   ```

4. From a tailnet member, `imp url <name>` prints the https URL. With HTTPS on, it comes first,
   before the local and tailnet URLs; a script that wants one of those picks it by its form.
   `imp login https://imp.example.com` reaches the API, and `https://imp.example.com` opens the
   [dashboard](./dashboard.md). Over HTTPS its session cookie is `__Host-imp_session`, which no imp
   under the domain can set ([daemon](../architecture/daemon.md#dashboard)).

The host must be on a tailnet (`TAILSCALE_AUTHKEY`). Without one, impd still gets the certificate,
but the HTTPS listeners answer only on loopback inside the host container.

**WARNING:** The token can change every DNS record in its zone. Keep it in the env file, or in a
token file, which only root can read. impd never logs it and never puts it in an error message. Do
not pass it on a command line.

### The token in a file

`IMP_DNS_API_TOKEN_FILE` names a file that holds the token, in place of `IMP_DNS_API_TOKEN`. A
secrets manager or other infrastructure as code can then own the token and drop it in place, and the
env file holds no secret. Set one of the two, not both: both is a start error.

```sh
IMP_DNS_API_TOKEN_FILE=/etc/imp/dns-api-token
```

The container sees `/etc/imp` read-only, so a file there (root, mode 0400) needs no extra mount. On
NixOS, set `services.imp.dnsApiTokenFile` instead ([NixOS](./nixos.md#the-dns-api-token)).

- The file holds the token alone, in ASCII. impd trims leading and trailing whitespace, and refuses
  a token with any character outside letters, digits and `._~+/-`: a pasted `IMP_DNS_API_TOKEN=...`
  line, two tokens, or a UTF-16 file.
- impd reads the file at each Cloudflare API call: each certificate attempt, each pass over the
  records. A new token works at the next call, without a restart.
- A file that is missing, empty or refused does not stop impd. impd starts, logs the path and what
  is wrong (never the file's contents), and each DNS call reads the file again. Certificate attempts
  back off as for any DNS failure (below), the certificate on disk keeps serving, and the records
  stay as they are. `imp info` (and `system.info` in the API) reads the file again each time you
  ask, and shows an error on its `https` line (`DNS token file readable` once it reads; with
  `IMP_DNS_API_TOKEN` there is no file to check, and the line shows the domain alone):

  ```text
  https       imp.example.com, ERROR: the DNS API token file /etc/imp/dns-api-token is empty
  ```

- While impd has no certificate, nothing listens on the HTTPS port, the HTTP port or the public
  ports: no imp is ever served as plain HTTP in its place. Once a certificate exists, the HTTP port
  only redirects to HTTPS. impd's API on its own port stays up throughout, so you can see the state
  and fix the file without a restart.
- Without `IMP_DOMAIN`, the file is unused, and impd logs a warning at start.

## How it works

### The certificate

One certificate covers `imp.example.com` and `*.imp.example.com`. A wildcard needs DNS-01, so impd
writes the challenge values as TXT records on `_acme-challenge.imp.example.com` through the DNS
provider. Both names put a value on that one record name, so impd adds both values side by side,
waits until every one of the zone's nameservers answers both, and only then tells the CA to look. It
removes both records after each attempt, success or not.

impd uses [acme-client](https://github.com/publishlab/node-acme-client) in-process. There is no
sidecar and no extra binary in the image.

### Renewal and failures

- A check runs at start and every 10 minutes. impd asks for a new certificate when there is none,
  when the one on disk does not cover both names, or when two thirds of its lifetime has passed (day
  60 of 90).
- impd never waits for the CA at start. The listeners start when a certificate exists, from disk or
  freshly issued.
- An expired certificate on disk still serves, with a log line, while renewal keeps failing. Clients
  then see an expiry error instead of no answer.
- A failed attempt backs off: 15 minutes, then 30, 60 and so on, up to a day. The count and the time
  of the last attempt live on disk, so a restart loop does not run into Let's Encrypt's limit of 5
  failed validations per name per hour. An attempt counts as failed until it succeeds, so a crash in
  the middle also backs off.

### Files

`<IMP_DATA_DIR>/tls/` is mode 0700, every file in it 0600:

| File              | Holds                                                                               |
| ----------------- | ----------------------------------------------------------------------------------- |
| `account.json`    | The ACME account: its key, and its URL at the ACME directory. Made once and reused. |
| `certificate.pem` | The certificate key, then the chain. One file, replaced by a rename.                |
| `attempts.json`   | Failed attempts in a row, the time of the last one, and its error text.             |

To force a new certificate, stop the container, delete `certificate.pem` and `attempts.json`, and
start it again.

### Listeners

impd listens on `IMP_HTTPS_PORT` (443) and `IMP_HTTP_PORT` (80), each on two addresses: the tailnet
IP and 127.0.0.1. It never listens on 0.0.0.0, so a port that Docker publishes to the internet never
reaches these listeners. impd checks the tailnet IP every 30 seconds and moves the listeners when it
changes. A failed check keeps them where they are, so it never cuts open connections.

- **443** terminates TLS and hands the request to the
  [wake proxy](../architecture/networking.md#the-wake-proxy). The Host header must be exactly
  `<name>.<domain>` for an imp, or exactly `<domain>` for the API. Anything else, such as
  `a.b.<domain>`, gets a 404. The bare domain therefore never reaches an imp named after its first
  label. The upstream request carries `x-forwarded-proto: https`. The dashboard's session cookie
  goes to the API on the bare domain, and never to an imp.
- **80** answers `308` with the same path on `https://`, for hosts under the domain only. It never
  wakes an imp.
- One wildcard certificate covers every name, so SNI needs no choice.
- A new certificate starts a second listener next to the old one (`SO_REUSEPORT`); the old one stops
  taking connections and lets its open ones finish. Bun cannot change the certificate of a running
  server. Open WebSockets survive a renewal.

### DNS records

impd sets two A records, `imp.example.com` and `*.imp.example.com`, to the host's tailnet IP,
DNS-only (`proxied: false`). It sets them at start and again whenever the tailnet IP changes. The IP
does change: Tailscale deletes an ephemeral node that stays offline, and the next start registers a
new node with a new IP ([state and ephemeral keys](./tailscale.md#state-and-ephemeral-keys)).

impd marks each record it writes with the comment `managed by impd`, and changes only those. A name
that already has an A, AAAA or CNAME record without that comment stops impd with an error that names
the record. impd never replaces a record it did not make. If it finds more than one record of its
own on a name, it logs a warning and updates only the first.

**CAUTION:** Give impd a name of its own, such as `imp.example.com`. Do not use a zone apex such as
`example.com` that already serves a website. impd refuses to replace the website's record, so HTTPS
never starts. If you delete that record so that impd can write its own, the website goes offline.

## Public imps

`imp expose <name>` serves one imp to the internet at `https://<name>.imp.example.com`. Every other
imp stays tailnet-only, and impd's API never answers on the internet.

```sh
imp expose web                  # a bearer token, the default
imp expose web --auth basic     # basic auth, user imp; --user picks another
imp expose web --auth none      # no auth: anyone with the URL
imp new web --public
imp unexpose web                # tailnet-only again, at once
```

impd makes the token or the password and prints it once. It keeps only a sha256 hash, so a lost
credential cannot be shown again. Running `imp expose` again on a public imp makes a new credential,
and the old one stops working at once; that is also how you change the auth. Rotating a credential
is an expose, so it needs a token with `manage` on the whole host too. A request without the right
credential gets a `401` before the imp wakes, so a stranger never boots it. The credential goes no
further than impd: the imp never sees the `Authorization` header, which also means an app behind
auth cannot use that header for itself. Use `--auth none` for an app that does its own auth.

`imp expose`, `imp unexpose` and `imp new --public` need a token with `manage` scope on the whole
host: a token limited to some imps cannot change which of them are on the internet.

`imp ls` notes `public (token)`, `public (basic)` or `public`, `imp url` prints the public URL, and
`imp info` shows the public IP, how many imps are public, and how the last pass over their DNS
records went. When an expose cannot write the imp's record, it prints a warning; the imp is public
anyway, and impd tries the record again every 10 minutes. A fork, a checkpoint restore and a backup
restore are tailnet-only until you expose them.

### Set it up

1. Add the host's public IPv4 to the env file:

   ```sh
   IMP_PUBLIC_IP=203.0.113.7
   ```

2. Publish the public listeners as the host's ports 443 and 80. With the systemd unit, set
   `IMP_PUBLIC_PORTS=-p 443:7443 -p 80:7480` in the same env file. With compose, uncomment the two
   ports in `deploy/compose.yaml`.
3. Open 443 and 80 in the host's firewall, then restart the host container.

**WARNING:** A public imp is on the internet. Anyone who finds its name can reach it when it has no
auth, and the name is in DNS. Expose only what you would put on the internet yourself.

### How it works

- **Listeners.** impd runs a second pair of listeners, TLS on `IMP_PUBLIC_HTTPS_PORT` (7443) and a
  redirect on `IMP_PUBLIC_HTTP_PORT` (7480), on every address in the host container. Docker
  publishes them as 443 and 80. The listener a request comes in on decides what it may reach, never
  the client's address: Docker's userland proxy can make a public client look like the bridge.
- **Routing.** The public listeners serve public imps only. A tailnet-only imp, a name that is no
  imp, and the bare domain all get the same `404`, whatever the Host header says, so the internet
  cannot tell which names exist. The redirect on 80 answers only for public imps too.
- **Limits.** Each public imp takes at most 64 requests and WebSockets open at once, 10 wakes in a
  burst and then one every 6 seconds, and 20 wrong credentials in a burst and then one every 3
  seconds. Over a limit, the answer is `429` with `Retry-After`. A request with no credential always
  gets the `401` challenge and counts against nothing, so a stranger cannot block a browser's
  password prompt; the right credential always passes too, so guessing cannot lock the owner out.
  The redirect on port 80 only checks that the name is a public imp: it takes no slot and no wake.
  The limits count per imp, not per client: behind Docker's userland proxy every client can share
  one source address.
- **Privacy.** A `502` or `503` on the public listener says only that the site did not answer or is
  not available, never why. The client's own `Forwarded`, `X-Real-IP` and `X-Forwarded-For` are
  dropped, and `X-Forwarded-For` holds only the address of the socket, or is left out when impd
  cannot read it. `X-Forwarded-Host` and `X-Forwarded-Proto` are impd's own: the Host it routed by,
  and `https`.
- **HTTP/1.1 only.** The listeners do not offer HTTP/2: `curl --http2` gets HTTP/1.1, because the
  server agrees on no ALPN protocol.
- **Records.** Each public imp gets its own A record, `<name>.imp.example.com`, at `IMP_PUBLIC_IP`,
  with the comment `impd public imps of imp.example.com`. A name of its own wins over the tailnet
  wildcard, so everyone resolves it to the public IP: tailnet members then reach the imp through the
  public listener, with the same auth. impd sets the record on an expose, removes it on an unexpose
  or a destroy, and checks every record with that comment one label under the domain at start and
  every 10 minutes. It removes the ones that are not public, and all of them when `IMP_PUBLIC_IP` is
  unset but `IMP_DOMAIN` is still set, so turning public mode off takes the records down too. It
  never touches a record with another comment: not the bare domain or the wildcard
  (`managed by impd`), not a record you made, and not the records of another impd on a name such as
  `dev.imp.example.com`, whose comment names its own domain. A domain too long for Cloudflare's
  100-character comment gets a hash of the domain in place of its name.
- **Certificate.** The wildcard certificate covers every public name, so a public imp needs no
  certificate of its own, and Certificate Transparency logs still show no imp names. DNS does.

### Limits of public mode

- The tailnet listeners still serve a public imp without its credential, to a client that reaches
  the tailnet IP directly (with `--resolve`, say): tailnet members are trusted, as they are for
  every other imp.
- Out of scope: IPv6 (no AAAA records), and detecting the public IP, which you set by hand.

## Why the records point at the tailnet IP

The domain is public, but its records point at a `100.64.0.0/10` address. That address routes only
inside your tailnet, so:

- Only tailnet members can connect. Everyone else resolves the name and gets an address they cannot
  reach. No firewall rule and no auth layer is needed for "private by default".
- DNS-01 never needs the host to be reachable, so a public CA issues the certificate for a host that
  has no public IP at all.
- A public IP in the records would expose the listeners to the internet. impd would then have to
  tell tailnet clients from public ones, and a client's source address is not reliable behind
  Docker's port publishing.

What the public learns: the domain exists, and it points at a CGNAT address. Certificate
Transparency logs show `*.imp.example.com`, but not the imp names.

**NOTE:** Some resolvers with DNS rebinding protection drop answers in private or CGNAT ranges,
`100.64.0.0/10` included. pfSense and OPNsense (Unbound with private-address filtering), dnsmasq
with `--stop-dns-rebind`, some home routers and some filtering DNS services do this. If a member
cannot resolve the domain, allow the domain in that resolver, or use MagicDNS's resolver on the
member.

## Tailscale serve

`tailscale serve` on the host takes tailnet ports for itself, before the traffic reaches impd. If it
holds 443 or 80, impd logs a warning at start:

```text
impd: https: warning: tailscale serve holds tailnet port 443, so impd never sees that traffic; ...
```

Remove it with `tailscale serve --https=443 off` or `tailscale serve reset`, in the host container.

## Testing with Pebble

The `https` suite of the end-to-end harness runs the whole flow on this machine, with no domain and
no token. [Pebble](https://github.com/letsencrypt/pebble) is Let's Encrypt's test CA, and
`pebble-challtestsrv` is the DNS server it asks:

```sh
IMP_DEV_NAME=imp-dev-https IMP_DEV_PORT_OFFSET=4500 scripts/test-e2e.sh --only https
```

The harness starts both containers on a Docker network of their own. The suite then reboots the dev
instance onto that network with `IMP_DOMAIN=imp.test`, `IMP_DNS_PROVIDER=challtestsrv`, the Pebble
directory, and Pebble's TLS root in `IMP_ACME_CA_FILE`, and reboots it with HTTPS off when it ends,
so the suites after it run against a plain impd. The suite waits for the certificate, checks both
names on it, fetches an imp over https from inside the host container, sleeps it and wakes it by
https, and checks the 404 and the redirect. It wakes the imp by https and by plain HTTP under the
same conditions, and records both times as the client sees them.

`IMP_DNS_PROVIDER=challtestsrv` exists for this test only. challtestsrv cannot list records, so its
provider remembers the A records this impd wrote, with their comments, and lists those. A restarted
impd forgets them; a public record it wrote before the restart stays in challtestsrv until the
harness removes challtestsrv at the end of the run. It writes records through challtestsrv's
management API at `IMP_DNS_API_URL`. impd refuses it unless `IMP_E2E=1`, which only the harness
sets.

`bun run test:pebble` tests the issuer alone against its own Pebble. It runs in CI. It checks a
first certificate, a renewal on the same account, an untrusted ACME server, and a Cloudflare that
refuses the token. Both errors must be readable and must not contain the token.

## Not yet

- Cloudflare is the only real DNS provider. Another provider implements `DnsProvider` in
  `packages/daemon/src/https/dns/`: add a TXT value, remove it by ID, wait for the nameservers, and
  set, list and remove A records.
- Public imps have no AAAA records, and the public IP is set by hand.
