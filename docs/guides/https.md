# HTTPS on your own domain

With `IMP_DOMAIN=imp.example.com`, every imp is at `https://<name>.imp.example.com`, and impd's own
API is at `https://imp.example.com`. Both answer on the tailnet only; public mode is
[#52](https://github.com/zgeoff/imp/issues/52). impd gets one wildcard certificate from Let's
Encrypt with the ACME DNS-01 challenge, renews it, and keeps the DNS records pointed at the host's
tailnet IP. Without `IMP_DOMAIN`, nothing changes: the
[per-port URLs](../architecture/networking.md#urls) stay the only tailnet URLs.

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

4. From a tailnet member, `imp url <name>` prints the https URL first.
   `imp login https://imp.example.com` reaches the API, and `https://imp.example.com` opens the
   [dashboard](./dashboard.md). Over HTTPS its session cookie is `__Host-imp_session`, which no imp
   under the domain can set ([daemon](../architecture/daemon.md#dashboard)).

The host must be on a tailnet (`TAILSCALE_AUTHKEY`). Without one, impd still gets the certificate,
but the HTTPS listeners answer only on loopback inside the host container.

**WARNING:** The token can change every DNS record in its zone. Keep it in the env file, which only
root can read. impd never logs it and never puts it in an error message. Do not pass it on a command
line.

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

| File              | Holds                                                                     |
| ----------------- | ------------------------------------------------------------------------- |
| `account.key`     | The ACME account key. Made once and kept.                                 |
| `account.json`    | The account's URL at the ACME directory, so a renewal reuses the account. |
| `certificate.pem` | The certificate key, then the chain. One file, replaced by a rename.      |
| `attempts.json`   | Failed attempts in a row, the time of the last one, and its error text.   |

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

The harness starts both containers on a Docker network of their own, then starts the dev instance on
that network with `IMP_DOMAIN=imp.test`, `IMP_DNS_PROVIDER=challtestsrv`, the Pebble directory, and
Pebble's TLS root in `IMP_ACME_CA_FILE`. The suite waits for the certificate, checks both names on
it, fetches an imp over https from inside the host container, sleeps it and wakes it by https, and
checks the 404 and the redirect. It wakes the imp by https and by plain HTTP under the same
conditions, and records both times as the client sees them.

`IMP_DNS_PROVIDER=challtestsrv` exists for this test only. It writes records through challtestsrv's
management API at `IMP_DNS_API_URL`. impd refuses it unless `IMP_E2E=1`, which only the harness
sets.

`bun run test:pebble` tests the issuer alone against its own Pebble. It runs in CI. It checks a
first certificate, a renewal on the same account, an untrusted ACME server, and a Cloudflare that
refuses the token. Both errors must be readable and must not contain the token.

## Not yet

- Public mode (`imp url <name> --public`, with an optional token or basic auth) is
  [#52](https://github.com/zgeoff/imp/issues/52). Every imp on the domain is tailnet-only.
- Cloudflare is the only real DNS provider. Another provider implements `DnsProvider` in
  `packages/daemon/src/https/dns/`: add a TXT value, remove it by ID, wait for the nameservers, and
  set an A record.
