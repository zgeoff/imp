# The end-to-end harness

The harness runs each journey file as its own `bun test` process against one dev instance, and it
returns the instance to a baseline after every journey. A journey therefore starts clean whatever
the journey before it did. The
[development runbook](../../../../docs/runbooks/development.md#end-to-end-tests) owns how to run the
harness: the suites, the flags, the tuning variables, the moves suites' second host and the tailnet
suites. This file covers what a journey author needs. The harness code and its unit tests live in
[`e2e/lib/`](../../../../e2e/lib/), and the unit tests run in plain `bun test` without KVM.

## A run, stage by stage

1. The harness brings the dev instance up, checks its container's privileges against the deploy
   files, reads the root token, resets the baseline for every suite prefix, and builds each fixture
   image that impd lacks.
2. For each suite, the harness reboots the instance onto the suite's own impd settings when the
   suite declares any, and starts the suite's fixtures, such as the second host of the moves suites.
3. After each journey, whether it passed, failed or was stopped, the harness resets the baseline for
   the suite's prefix and resets the suite's fixtures. After a failed journey, it first reboots the
   instance onto the suite's settings, because the journey may have left impd on settings of its
   own.
4. When a reset or a reboot fails, the harness fails the suite and makes the instance anew before
   the next journey. When that fails too, the run stops.
5. After the last journey of a suite, the harness reboots the instance back onto the run's settings
   and stops the suite's fixtures.
6. At the end, unless `--keep`, the harness removes every `e2e-` imp and image and writes the
   results file.

One exception to the reset after each journey: a passing `scale` keeps its fleet for `restart`,
which checks that impd adopts the whole fleet again. The instance also stays on scale's settings
until restart ends.

## What the baseline reset covers

The baseline reset removes every imp, network, secret, OAuth client, token, image and template whose
name starts with the suite's prefix, and the broker's test-upstreams file. Before that, it aborts
any move a failed journey left marked, because impd refuses to remove an imp in the middle of a
move. A removal that impd refuses fails the reset, and so the suite.

The reset leaves three things alone:

- The instance's own settings. The reboot after a failed journey restores those.
- A registry container or an SSH key that a journey made. The journey removes it itself.
- A fixture image, whose name carries a hash of its sources instead of a suite prefix. A changed
  fixture therefore builds anew, and an unchanged one survives every reset.

## Writing a journey

A journey's `setupTest()` creates one stack, registers its disposal, and returns the run's client
and the suite's prefix. Name everything the journey makes with that prefix, so the baseline reset
can find it after a crash. Register each removal through the removal helper on the line after the
act that made the thing. The stack then removes an imp before the template it boots and the network
it joins. Under `--keep` the helper defers no removal, so the imps and images stay for a look
afterwards, while the other releases, such as a proxy process, still run.

Put impd settings that every journey of a suite needs on the suite itself rather than in a journey.
A journey that needs settings only it uses reboots onto them over the suite's settings and defers a
reboot back, so the journeys after it run on the suite's settings.

These guest and host facts decide how a journey is built:

- A burst of connections past a guest server's accept backlog leaves some that the agent dialed but
  the server never accepted. The guest kernel drops them about 17 s later, and `impz proxy` reports
  a lost connection. A journey that holds many connections uses an echo server and proves each
  connection with a round trip before it opens the next.
- A unix socket path holds at most 107 bytes, which a worktree's cache directory can exceed. Put
  ssh-agent and forward sockets in a temporary directory under `TMPDIR`.
- To prove that something keeps an imp awake past its idle timeout, use the harness's
  awake-past-idle wait, and run no exec in the imp during it, because an exec records activity.
- Run alone, a journey file gets no baseline reset and no fixture build, and the shell's
  `IMP_RAM_BUDGET_MIB` and `IMP_IDLE_TIMEOUT_S` override the run's values.

## Sets, groups and acceptance

The `acceptance` set is every suite. The `fast` set is the CI subset, split into three static groups
for three CI runners with an instance each. The suites' unit test pins that no suite sits in two
groups and that the groups make up the `fast` set, and the CI groups test pins the groups against
the workflow file. Change all three together. A run that includes `acceptance` makes the tailnet
suites fail instead of skipping and makes the timing limits fail the run instead of warning.

## Host safety

The harness touches machine-global resources only where it can prove they are its own:

- A wipe deletes a data dir as root, so the harness wipes only a dir under `.data/`, a dir that
  holds the instance's XFS file, or a ZFS root that the ZFS host script's owner file proves.
- The `registry` suite trusts its registry's certificate through Docker's fixed per-registry
  directory. It makes that directory without `--parents`, writes an owner file with its process's
  pid and start time, and removes a stale directory only when the owner file proves that its process
  is gone.
- The tailnet suites join as `tag:imp-e2e`, never `tag:imp`, so a test node cannot reach a live
  impd. An instance that once joined as `tag:imp` keeps that node state until a `--clean` run.
