# The e2e tailnet tag

impz owns the tailnet tag `tag:imp-e2e`, its OAuth client and the 1Password vault `imp-e2e`. The e2e
harness's tailnet suites and a dev instance started with `IMP_TAILSCALE_OP=1` both join the tailnet
as `tag:imp-e2e`, so neither reaches a live impd on `tag:imp`. The tailnet has one policy file, and
the infrastructure repo that holds it applies it whole; this runbook states the part of that file
impz relies on, so a change there that breaks impz's tests breaks this contract.
[Development](./development.md) covers how to run the suites, and
[configuration](../guides/configuration.md#dev-instance) covers the order in which `dev.sh` looks
for a key.

## What impz relies on

| Where                                              | Holds                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| the tailnet policy                                 | the tag `tag:imp-e2e`, owned by admins and itself, and its one grant |
| the OAuth client `imp-e2e`                         | scope Auth Keys (write) only, tag `tag:imp-e2e` only                 |
| vault `imp-e2e`, item `imp-e2e-tailscale-oauth`    | the client's `client-id` and `client-secret`                         |
| vault `imp-e2e`, item `imp-e2e-tailscale-services` | the Services OAuth client of the per-imp names case, when you run it |

The policy holds these two entries for the tag, and no grant that takes `tag:imp-e2e` to `tag:imp`:

```json
{
  "tagOwners": { "tag:imp-e2e": ["autogroup:admin", "tag:imp-e2e"] },
  "grants": [{ "src": ["tag:imp-e2e"], "dst": ["tag:imp-e2e"], "ip": ["tcp:7070"] }]
}
```

The tag owns itself because an OAuth client mints keys only for tags its own tags own. The grant
lets the moves suites' two impds reach each other's API. Members reach every tagged node through the
policy's members grant, so you reach a dev instance on `tag:imp-e2e` as you would any host.

## How the scripts use the client

`scripts/lib.sh` reads the client secret with `op read`, adds `?ephemeral=true&preauthorized=true`,
and passes it to `tailscale up` as the auth key with `--advertise-tags=tag:imp-e2e`. Each node is
ephemeral, so Tailscale removes it soon after it goes offline, and a dev instance that restarts
later joins again with the same secret. No script defaults to an item outside the `imp-e2e` vault.
The `imp` op-mint profile's token reads that vault and nothing else.

## Replace the client

1. In the Tailscale admin console's trust credentials page, add an OAuth credential: description
   `imp-e2e`, scope Auth Keys (write) only, tag `tag:imp-e2e` only.
2. Store its ID and secret in the vault `imp-e2e`, item `imp-e2e-tailscale-oauth`, fields
   `client-id` and `client-secret`. Never paste the secret into a command line.
3. Revoke the old client on the same page.

The secret does not expire. Replace it when it may have leaked.

## Check the isolation

From a `tag:imp-e2e` node, a request to the API of a live impd on `tag:imp` must time out, because
the policy gives the node no route to it. Use a TCP request such as
`curl --max-time 5 http://<impd_tailnet_ip>:7070/`. A plain `tailscale ping` does not test this,
because its default ping tests the connection between the two devices, not the policy. The
`moves-tailnet` suite fails with the grant to add when two `tag:imp-e2e` nodes cannot see each
other.
