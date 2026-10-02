# Changelog

## [0.8.0](https://github.com/zgeoff/imp/compare/v0.7.0...v0.8.0) (2026-10-02)


### Features

* **agent:** kill a stopped command's whole process group ([c2b7371](https://github.com/zgeoff/imp/commit/c2b7371f1a2f83b068fbd8c5b4a070beb032e4e1)), closes [#51](https://github.com/zgeoff/imp/issues/51)
* **agent:** kill what is left of a stopped exec's process group ([f245c56](https://github.com/zgeoff/imp/commit/f245c560e8ecc2493215c6ce4edfe4529f2d34cd))
* an exec takes a kill grace and reports the agent's group kill ([fc3e3e8](https://github.com/zgeoff/imp/commit/fc3e3e8c43e2fe8ae0c25ac62caf740f70c575c5))
* **api:** bind ssh keys to tokens in the contract ([#63](https://github.com/zgeoff/imp/issues/63)) ([3e9a94a](https://github.com/zgeoff/imp/commit/3e9a94aa91d8c51502886aa344cceb0b7261111b))
* **client:** let the caller open the exec socket ([35034b7](https://github.com/zgeoff/imp/commit/35034b7c9d8eebb7f1107604c4d1f83c4accf24f))
* **cli:** imp token key add, ls and rm, and new --ssh-key ([#63](https://github.com/zgeoff/imp/issues/63)) ([598da72](https://github.com/zgeoff/imp/commit/598da7273bc57d7932b96131d10b9e0d8fa5da92))
* **daemon:** serve mcp over http at /mcp ([63a7ec1](https://github.com/zgeoff/imp/commit/63a7ec1c67db2c91f439c13b032a45b4c539f2dd)), closes [#50](https://github.com/zgeoff/imp/issues/50)
* **daemon:** ssh logins with a bound key run as its token ([#63](https://github.com/zgeoff/imp/issues/63)) ([9f45e07](https://github.com/zgeoff/imp/commit/9f45e07956fffaaf4f1d8d72fb3c6d3a03c699d6))
* **daemon:** store ssh keys bound to tokens ([#63](https://github.com/zgeoff/imp/issues/63)) ([124f67d](https://github.com/zgeoff/imp/commit/124f67dcf634e79ed7952cee19366471a5c3d56c))
* **dashboard:** list the ssh keys bound to each token ([#63](https://github.com/zgeoff/imp/issues/63)) ([f969f0a](https://github.com/zgeoff/imp/commit/f969f0aba80afce60cc2855baa6def8a3b5590c2))
* **deploy:** one-command server bootstrap ([7f87178](https://github.com/zgeoff/imp/commit/7f87178b7c491dc901eae830c0a562b8ea8fd957)), closes [#9](https://github.com/zgeoff/imp/issues/9)
* **mcp:** add a streamable http transport and a pattern guard ([6bd91fa](https://github.com/zgeoff/imp/commit/6bd91fa8ea1b7968abba0c5d7b087411d94681a6))
* **mcp:** let the agent kill a stopped command's process group ([753448a](https://github.com/zgeoff/imp/commit/753448ac438ec0a4f561f2faf869bf84d3fb90ec))
* **mcp:** serve mcp over http from impd with scoped tokens ([1235313](https://github.com/zgeoff/imp/commit/1235313917b85302bf3af0770f8f23e0a0b0c258)), closes [#50](https://github.com/zgeoff/imp/issues/50)
* **ssh:** bind ssh keys to scoped tokens ([0436331](https://github.com/zgeoff/imp/commit/0436331cddbdee70ebdab95a7be21be3afc24b1c)), closes [#63](https://github.com/zgeoff/imp/issues/63)


### Bug Fixes

* **daemon:** cap long timers at the runtime's limit ([abbc951](https://github.com/zgeoff/imp/commit/abbc951dd44f77bd8f7b2f7139d6f1008ffa21e9))
* **daemon:** cap the event stream's end timer at setTimeout's limit ([830b437](https://github.com/zgeoff/imp/commit/830b437606e659eedc91368fad7dd741a9a0d882))
* **daemon:** judge /mcp origins by the dashboard's same-origin rule ([0e7380d](https://github.com/zgeoff/imp/commit/0e7380da50cc436c717c91001573700612f59453))
* **daemon:** never unbind a key that authorized_keys lists ([#63](https://github.com/zgeoff/imp/issues/63)) ([630ea7c](https://github.com/zgeoff/imp/commit/630ea7c60c12019556b4887bed04608ab03cd09e))
* **db:** number the token ssh keys migration 008 ([ed3d197](https://github.com/zgeoff/imp/commit/ed3d1971918a0d90843d22f6a65cb39563153dd3))
* **deploy:** refuse zfs when fstab mounts /var/lib/imp ([810ba9d](https://github.com/zgeoff/imp/commit/810ba9d6aa6bbee16c0114e8e443e0ceaa96b363))
* **dev:** read the tailscale key from 1password only when a run needs it ([7924b0b](https://github.com/zgeoff/imp/commit/7924b0b2ccd17ce8dd9b11a42d9c0fe0ce99de29))
* **e2e:** put the ignore-unknown line before every ssh host block ([3df70c0](https://github.com/zgeoff/imp/commit/3df70c0b70752aa79107ae9ccf82340a6f69dbf1))

## [0.7.0](https://github.com/zgeoff/imp/compare/v0.6.0...v0.7.0) (2026-10-02)

### Features

- **security:** egress policy per imp
  ([e4ab5ab](https://github.com/zgeoff/imp/commit/e4ab5ab493708681e1a9945c6acffd82bf3e1435)), closes
  [#26](https://github.com/zgeoff/imp/issues/26)

### Bug Fixes

- **daemon:** serialize slot changes with policy rollbacks
  ([#26](https://github.com/zgeoff/imp/issues/26))
  ([70bd00a](https://github.com/zgeoff/imp/commit/70bd00a17312b67380ce85e4ef6fb77e8395b4f1))

## [0.6.0](https://github.com/zgeoff/imp/compare/v0.5.0...v0.6.0) (2026-10-02)

### Features

- **dev:** read the tailscale key from 1password, with .env as fallback
  ([1ded041](https://github.com/zgeoff/imp/commit/1ded041ac9d2e4baab17c579add161deff20bc64))

### Bug Fixes

- **dev:** keep the tailscale key out of traces and ask op once
  ([bf64471](https://github.com/zgeoff/imp/commit/bf6447198c2eeae4a17569f0521b8bbbd2f7be59))

## [0.5.0](https://github.com/zgeoff/imp/compare/v0.4.0...v0.5.0) (2026-10-02)

### Features

- **agent:** grow the root filesystem to fill its disk
  ([22136ee](https://github.com/zgeoff/imp/commit/22136eebadfba55fae3a5b24263010c4f9a4cb9d))
- **backup:** keep disk sizes in the manifest
  ([0aafeda](https://github.com/zgeoff/imp/commit/0aafeda269929644945b6a7035c2a7869f454d12))
- **backup:** record each disk's used bytes, and restore by them
  ([db6fa76](https://github.com/zgeoff/imp/commit/db6fa7626748bc7cefaa36f174c1f57e48e3fab2))
- disk budget and per-imp disk use
  ([52658ee](https://github.com/zgeoff/imp/commit/52658ee7a5e2581782f0c1340f263ca939534c0e)), closes
  [#21](https://github.com/zgeoff/imp/issues/21)
- disk sizes on create, and a resize that only grows
  ([dd4c7bd](https://github.com/zgeoff/imp/commit/dd4c7bd74c23e35bbf54df1358f2d334e0f79fb0))
- **images:** size an image's ext4 to its tree
  ([7df8bce](https://github.com/zgeoff/imp/commit/7df8bceedb42612ad4e230567945a7b562b1ca25))
- **storage:** a disk budget with a reserve no write may take
  ([acc3d61](https://github.com/zgeoff/imp/commit/acc3d61429e97c0809e33acc6de22fab91006d88))
- **storage:** a gc behind a storage gate
  ([a2de654](https://github.com/zgeoff/imp/commit/a2de6546d30fbc833689a42337a246e96c642ce3))
- **storage:** grow a stopped disk's filesystem on the host
  ([5fd883c](https://github.com/zgeoff/imp/commit/5fd883c078b170733731256b40c46de5a39253fd))
- **storage:** measure each imp's exclusive and shared disk usage
  ([4b8f49e](https://github.com/zgeoff/imp/commit/4b8f49e89b13fad31d20feb073bc63cddad085b8))
- **storage:** one disk ledger, and a usage pass that resumes
  ([0f2cbc0](https://github.com/zgeoff/imp/commit/0f2cbc00bf88b897738b9d5226ceaa99667f842e))

### Bug Fixes

- **agent:** dial unix sockets as the image user, protocol 0.6.0
  ([#60](https://github.com/zgeoff/imp/issues/60))
  ([dcccdee](https://github.com/zgeoff/imp/commit/dcccdeeb931c50fba3f1e5fcee28e9b8a4080c33))
- **agent:** kill the dial helper by pidfd, its stdio on /dev/null
  ([#60](https://github.com/zgeoff/imp/issues/60))
  ([029e3d0](https://github.com/zgeoff/imp/commit/029e3d0c6a09ece8222e7ee6f895932ff34faa17))
- an atomic fake size file, and wait for the e2e usage pass
  ([d86bd6b](https://github.com/zgeoff/imp/commit/d86bd6b19f231bac98008cfb311c9bb7f4ff5419))
- **backup:** a restored image joins the storage gate until its row
  ([079dc9f](https://github.com/zgeoff/imp/commit/079dc9f217869f80456342dce00bbaf8e98f0204))
- **daemon:** unix socket forwards need agent 0.6.0 ([#60](https://github.com/zgeoff/imp/issues/60))
  ([7afc776](https://github.com/zgeoff/imp/commit/7afc77690ebe8c83c96d3aa55214a032b87f0093))
- disk sizes reach the event stream; usage follows the write feed
  ([047e2ac](https://github.com/zgeoff/imp/commit/047e2acd1c89fd938e2333580ac423b11857e62b))
- unix socket forwards dial as the image user
  ([99e01dd](https://github.com/zgeoff/imp/commit/99e01dde5482fa9d8e30aa429a49f35defdc87d7)), closes
  [#60](https://github.com/zgeoff/imp/issues/60)
- wakes pass the disk reserve; an old agent's grow is agent_outdated
  ([f2f2836](https://github.com/zgeoff/imp/commit/f2f2836df1deb90e1161061816137e4fd4e829bc))

## [0.4.0](https://github.com/zgeoff/imp/compare/v0.3.0...v0.4.0) (2026-10-02)

### Features

- **cli:** add imp events and imp audit --kind api ([#38](https://github.com/zgeoff/imp/issues/38))
  ([d740737](https://github.com/zgeoff/imp/commit/d7407372dbb4ff39f7411c2a8807f465bcc51a0f))
- **cli:** imp proxy forwards local ports into an imp
  ([8e98e4c](https://github.com/zgeoff/imp/commit/8e98e4c560d12bc6a9487dbc5a4fcc4fbd7d58c4)), closes
  [#25](https://github.com/zgeoff/imp/issues/25)
- **cli:** imp proxy forwards local ports into an imp
  ([#25](https://github.com/zgeoff/imp/issues/25))
  ([2f020f9](https://github.com/zgeoff/imp/commit/2f020f9df167f2ed7db6a940296297e61c33da67))
- **daemon:** export opentelemetry metrics and spans when asked
  ([#38](https://github.com/zgeoff/imp/issues/38))
  ([a0699ac](https://github.com/zgeoff/imp/commit/a0699acadf1ce185f06940a5748b6229b14aed2f))
- **daemon:** stream imp lifecycle events and audit api calls
  ([#38](https://github.com/zgeoff/imp/issues/38))
  ([1f84fbc](https://github.com/zgeoff/imp/commit/1f84fbcc39402e0bab78039fbfbf6872fc5a4ed6))
- **dashboard:** follow impd's event stream in place of a 2 s poll
  ([#38](https://github.com/zgeoff/imp/issues/38))
  ([bd35934](https://github.com/zgeoff/imp/commit/bd3593448eccb67ea933a137fbcfcfc86f06d013))
- stream imp events, audit api calls and export metrics
  ([1072ade](https://github.com/zgeoff/imp/commit/1072adec1cea5914b21cc216193ffa712b5df175)), closes
  [#38](https://github.com/zgeoff/imp/issues/38)

### Bug Fixes

- **cli:** proxy close codes, bad json, port hints and retries
  ([#25](https://github.com/zgeoff/imp/issues/25))
  ([5859d87](https://github.com/zgeoff/imp/commit/5859d87c08b228221c04f9cace689bec741d8f1c))
- **daemon:** close a tunnel that passes its window ([#25](https://github.com/zgeoff/imp/issues/25))
  ([990949d](https://github.com/zgeoff/imp/commit/990949dcbf195787d4f71fbb789a84c6ed644a56))
- **daemon:** count the tunnel cap by imp id, not name
  ([#25](https://github.com/zgeoff/imp/issues/25))
  ([74cefa2](https://github.com/zgeoff/imp/commit/74cefa2c6a8d9240f1e9dd78ea5d3cc9f9db89cc))

## [0.3.0](https://github.com/zgeoff/imp/compare/v0.2.2...v0.3.0) (2026-10-02)

### Features

- forward the user's ssh-agent into an imp
  ([0b299d2](https://github.com/zgeoff/imp/commit/0b299d2ace27554aef1676f8c1a2e9a0e94c546c)), closes
  [#53](https://github.com/zgeoff/imp/issues/53)

### Bug Fixes

- **backup:** wait for restic locks and list snapshots without one
  ([6c02a4e](https://github.com/zgeoff/imp/commit/6c02a4e9c2cdcb3f846ce7c15e9c4a1539b49bc0))

## [0.2.2](https://github.com/zgeoff/imp/compare/v0.2.1...v0.2.2) (2026-10-02)

### Bug Fixes

- **https:** keep the acme account key with its url
  ([31706c5](https://github.com/zgeoff/imp/commit/31706c5da442d34d01437e330735b69047f49525))
- **net:** keep the acme account key and url together
  ([647c2fd](https://github.com/zgeoff/imp/commit/647c2fdc5f68de804e467233e943ccc77299edfc))
- **net:** move the v0.1.1 acme account into account.json
  ([68a2451](https://github.com/zgeoff/imp/commit/68a2451caa0785ad79f6c48f914456753bff2a1b))
- **test:** take test ports from below the kernel's ephemeral range
  ([c8f004a](https://github.com/zgeoff/imp/commit/c8f004acd7860c647ea52321c99f6571824d8479))

## [0.2.1](https://github.com/zgeoff/imp/compare/v0.2.0...v0.2.1) (2026-10-02)

### Bug Fixes

- **agent:** leave uptime out of ping when the clock read fails
  ([47fcb71](https://github.com/zgeoff/imp/commit/47fcb71a8d13f4ba1eee7310d1333bea0b51e568)), closes
  [#33](https://github.com/zgeoff/imp/issues/33)
- **build:** keep ssh2's optional cpu-features out of the impd binary
  ([5c654d3](https://github.com/zgeoff/imp/commit/5c654d3c1ab08e3b3babb8acd040161d6b8f4c14))
- **daemon:** bound the young-guest wait and skip it for the governor
  ([c655703](https://github.com/zgeoff/imp/commit/c65570307e3c78f181e0a08b008e5f18dcd171d2)), closes
  [#33](https://github.com/zgeoff/imp/issues/33)
- **daemon:** wait for a young guest before a sleep
  ([bfac671](https://github.com/zgeoff/imp/commit/bfac671fda13be038df5feb59fa19f64f7dc22c4)), closes
  [#33](https://github.com/zgeoff/imp/issues/33)
- wait for a young guest before a sleep, so its wake is fast
  ([9c3bc37](https://github.com/zgeoff/imp/commit/9c3bc370c153883df94175700e4e4925386c17cc)), closes
  [#33](https://github.com/zgeoff/imp/issues/33)

## [0.2.0](https://github.com/zgeoff/imp/compare/v0.1.1...v0.2.0) (2026-10-02)

### Features

- **cli:** show boot status in imp info and after an upgrade
  ([1fb9131](https://github.com/zgeoff/imp/commit/1fb9131ae0a67f34cd770d0cfadbe64c0cb47781))
- **daemon:** count cold boots and outdated imps in system.info
  ([b0515fc](https://github.com/zgeoff/imp/commit/b0515fc47173ceaf126ecfd1651c2457d4047a28))
- show boot status after an upgrade in imp info
  ([54ab78f](https://github.com/zgeoff/imp/commit/54ab78f07b7bfa9ae46d2e2e4ac560ec664a94b2)), closes
  [#49](https://github.com/zgeoff/imp/issues/49)

### Bug Fixes

- **cli:** show boot status as unknown for an older impd
  ([1d3665d](https://github.com/zgeoff/imp/commit/1d3665dd729f60cafdd5d6d032bf1ea2f53c4f10))

## [0.1.1](https://github.com/zgeoff/imp/compare/v0.1.0...v0.1.1) (2026-10-02)

### Bug Fixes

- **daemon:** pick again after each governor sleep
  ([bf8481b](https://github.com/zgeoff/imp/commit/bf8481b7a19b8856a43af20c5b2c957e27af1ded))
- pick again after each governor sleep
  ([dc8a01c](https://github.com/zgeoff/imp/commit/dc8a01c0d615b7a73a3dc368b6ca71459fd3465e)), closes
  [#47](https://github.com/zgeoff/imp/issues/47)
- **release:** give npm publish a ./ path to the tarball
  ([7cb1378](https://github.com/zgeoff/imp/commit/7cb13785e4de0aa2247456e7e7266266be9649c0))
- **storage:** mount zfs backup clones with -o ro
  ([403f90d](https://github.com/zgeoff/imp/commit/403f90d5f7eac569d2e1749e3d5b0ec2e40cc6cf))

## 0.1.0 (2026-10-02)

### Features

- **agent:** detachable sessions with replay and mode tracking
  ([67fd3cf](https://github.com/zgeoff/imp/commit/67fd3cf68e004b7cdbc4609b25783823c09f78e0))
- **api:** report the resident memory of each awake imp
  ([85d1e8a](https://github.com/zgeoff/imp/commit/85d1e8a6b29a32b6cb25a3c20566a2097581d2ca))
- **cli:** add imp secret, grant, revoke, grants and audit
  ([ad59b7f](https://github.com/zgeoff/imp/commit/ad59b7fbfd45e36c8177f250d3e1d6f0e3ee84f3))
- **cli:** detachable consoles, imp sessions and imp attach
  ([7641435](https://github.com/zgeoff/imp/commit/764143563f864a1a380c3644b66fa3399ef0fc03))
- **client:** add @zgeoff/imp-client and exec tickets
  ([c70bda0](https://github.com/zgeoff/imp/commit/c70bda092b7e3422e6a2d0f71daef41d2e31d295)), closes
  [#17](https://github.com/zgeoff/imp/issues/17)
- **client:** add @zgeoff/imp-client, a typed client for impd
  ([3284973](https://github.com/zgeoff/imp/commit/3284973c105a9417514523a201e42268a49bc8ff))
- **client:** add exec, run and console helpers
  ([0544fa9](https://github.com/zgeoff/imp/commit/0544fa9548d3ee61b467339eb7aa157ef2fb5b95))
- **client:** add exec, run and console helpers to the sdk
  ([227889a](https://github.com/zgeoff/imp/commit/227889a124d3f3a3787dd821804e046cc988413f)), closes
  [#17](https://github.com/zgeoff/imp/issues/17)
- **cli:** host profiles, completions, brew tap and install script
  ([529e866](https://github.com/zgeoff/imp/commit/529e8667cde32d2b7b4d57f03952329af2ce6619)), closes
  [#19](https://github.com/zgeoff/imp/issues/19)
- **cli:** note cold boots and outdated parts in imp ls
  ([9451def](https://github.com/zgeoff/imp/commit/9451def6556319e3b5107ffb1fbbe6eeeeae1b80))
- **cli:** note imps an older impd booted
  ([456a498](https://github.com/zgeoff/imp/commit/456a498d593ddbee8bc7725873868ed9870ce164))
- **cli:** print shell completions with imp completion
  ([dce4ba9](https://github.com/zgeoff/imp/commit/dce4ba990d0aba21feb7792c5f0b00c0d7cfe3e9))
- **cli:** save impd hosts with imp login and pick one with --host
  ([2248a81](https://github.com/zgeoff/imp/commit/2248a81ac3a97a46dcc3ac15e88f30d996105050))
- **cli:** serve imps as mcp tools over stdio with imp mcp
  ([f065796](https://github.com/zgeoff/imp/commit/f0657965743df19343d00f7c479ee6838cbfd94d))
- credential connectors through a host-side broker
  ([331b007](https://github.com/zgeoff/imp/commit/331b007aaf8845bd4f3e8e7aed1c2d7043cbd962)), closes
  [#15](https://github.com/zgeoff/imp/issues/15)
- **daemon:** add a zfs storage backend
  ([1d394b9](https://github.com/zgeoff/imp/commit/1d394b96b811890bca969e3795ae70cfa4ee4899))
- **daemon:** add the https settings and the dns providers
  ([c920a3a](https://github.com/zgeoff/imp/commit/c920a3ac74997861a2f12cea3c8c98cfc67806fb))
- **daemon:** authenticate /exec with single-use tickets
  ([6ac6fd4](https://github.com/zgeoff/imp/commit/6ac6fd437fb3495227a090be9d65ce2d4cf4cb85))
- **daemon:** broker credentials for imps through a host-side proxy
  ([0feea06](https://github.com/zgeoff/imp/commit/0feea06cdc14aa776c93aa7d371a6d637b921fb0))
- **daemon:** choose the storage backend by config
  ([92b1bc5](https://github.com/zgeoff/imp/commit/92b1bc5cfd501b61cb96349c46d8c2430ef98d08))
- **daemon:** issue a wildcard certificate with acme dns-01
  ([5aa3396](https://github.com/zgeoff/imp/commit/5aa33966178f156b130220ec3fe138d9887bbb70))
- **daemon:** let wake refuse an imp in error, and tighten exec grants
  ([ee6e8f9](https://github.com/zgeoff/imp/commit/ee6e8f9ab97ec7a29c6fdc9c4c8f46f4b5d91de9))
- **daemon:** list, kill and attach detachable sessions
  ([b501d2d](https://github.com/zgeoff/imp/commit/b501d2d672fafb15d916b8d06b79a4924566a269))
- **daemon:** print the version with impd --version
  ([f066da9](https://github.com/zgeoff/imp/commit/f066da9a4bef780a35e53144ca875ed929a660c3))
- **daemon:** restore snapshots across an upgrade and say why not
  ([4accb37](https://github.com/zgeoff/imp/commit/4accb3700adee6e9754ae7549b5abe2c2f31cbdb))
- **daemon:** serve imps at https://&lt;name&gt;.&lt;domain&gt; on the tailnet
  ([c3478cc](https://github.com/zgeoff/imp/commit/c3478cc0e552d32aafc293ccf633481a5363ce9f))
- **daemon:** serve the dashboard and sign it in with a session cookie
  ([c869535](https://github.com/zgeoff/imp/commit/c869535185ea99001f8f4d2a67cf98a387858bcd))
- **daemon:** use a host-only secure session cookie over https
  ([a0c9558](https://github.com/zgeoff/imp/commit/a0c9558ee6a730e8f985de786ddd89ee7a179ea5))
- **dashboard:** add the web dashboard on tanstack router and the sdk
  ([5ec738f](https://github.com/zgeoff/imp/commit/5ec738fe5cad54d691b4d2ec763648b0131778e0))
- **dashboard:** show an imp's https url first
  ([b6324d6](https://github.com/zgeoff/imp/commit/b6324d659a5185838c80362a4f4eacd299807dbf))
- **deploy:** add upgrade.sh that sleeps imps before the restart
  ([9f541f8](https://github.com/zgeoff/imp/commit/9f541f86df24a477e096d24c2a1bae319adee719))
- detachable sessions
  ([fe475eb](https://github.com/zgeoff/imp/commit/fe475ebc30ec5914e9f707de8a21823715d09526)), closes
  [#13](https://github.com/zgeoff/imp/issues/13)
- **host:** mount a zfs dataset as the data dir
  ([ec9de15](https://github.com/zgeoff/imp/commit/ec9de15547d06b632f92ef0cd3f49721552946eb))
- **host:** open the broker port to guests and filter spoofed sources
  ([4dcfbcf](https://github.com/zgeoff/imp/commit/4dcfbcfc0f82f65081a4505ab64a09813ca68ea3))
- https urls on your own domain
  ([780e522](https://github.com/zgeoff/imp/commit/780e5223184a2afa825d0629d3f536dbb7e6b503)), closes
  [#16](https://github.com/zgeoff/imp/issues/16)
- **mcp:** add an mcp server package with imp tools
  ([74507d1](https://github.com/zgeoff/imp/commit/74507d1ef64a2334fc5aaa624322b8f8c6182624))
- **mcp:** serve imps as mcp tools with imp mcp
  ([15eca71](https://github.com/zgeoff/imp/commit/15eca7115eb4443e8556584ce8766bb78f6a3eb2)), closes
  [#20](https://github.com/zgeoff/imp/issues/20)
- **release:** install the cli with a checked install script
  ([5c35cc8](https://github.com/zgeoff/imp/commit/5c35cc81bdbdc7655990ffb0f53bb7d5143885a4))
- **release:** update the homebrew formula in the tap
  ([9f14870](https://github.com/zgeoff/imp/commit/9f1487071c3c91cbca249b5e30c1d63c96a59312))
- **scripts:** add a kvm probe that fails fast without /dev/kvm
  ([d8493bf](https://github.com/zgeoff/imp/commit/d8493bf761b822a1bd7d21b8735c789459bf25b7))
- **scripts:** let dev.sh use a host image built elsewhere
  ([9dfb983](https://github.com/zgeoff/imp/commit/9dfb9830fcec9046f8947316fa956b23deaadf90))
- upgrade impd without losing imps
  ([e13b0a4](https://github.com/zgeoff/imp/commit/e13b0a41b04f606dcbfa81545d86140e93b6cf56)), closes
  [#10](https://github.com/zgeoff/imp/issues/10)
- web dashboard served by impd
  ([f4a0391](https://github.com/zgeoff/imp/commit/f4a0391cf8ff03a808ca0533ffe9ca74a2fcbc2f)), closes
  [#18](https://github.com/zgeoff/imp/issues/18)
- zfs storage backend
  ([4581294](https://github.com/zgeoff/imp/commit/458129432a65bb3c95eee0b16e513f8c33cf6062)), closes
  [#11](https://github.com/zgeoff/imp/issues/11)

### Bug Fixes

- **agent:** gofmt the session viewer, and gate pushes on the go job
  ([94ab9be](https://github.com/zgeoff/imp/commit/94ab9beb4504f0efc51ca4d77255e69a5c1a1742)), closes
  [#13](https://github.com/zgeoff/imp/issues/13)
- **agent:** keep an unsent exit and bound viewers that stop reading
  ([968c664](https://github.com/zgeoff/imp/commit/968c66468fd083c21298dd45e38a8c69e46eacc0))
- **api:** type exec frames so a browser websocket accepts them
  ([3ee5429](https://github.com/zgeoff/imp/commit/3ee54296d20be015297c4d61fb8b5dcb10ddc961))
- **broker:** keep plain-tunnel tests off the network
  ([58c9a6f](https://github.com/zgeoff/imp/commit/58c9a6f2d8c8030d1405817ea96ef53b55f955f4))
- **cli:** end exec sessions cleanly on every failure and signal
  ([7ed046e](https://github.com/zgeoff/imp/commit/7ed046eb92e295ecf217400f2b3cdba022a46697))
- **client:** bound unread exec output and stop on cancel
  ([eb87eb0](https://github.com/zgeoff/imp/commit/eb87eb014e07fc6b117860e19dd57c747b301df3))
- **client:** make the awake helper one wake call that rides out restarts
  ([9bdb563](https://github.com/zgeoff/imp/commit/9bdb56380221148dfa95985b4eaa5073052b147c))
- **cli:** exit 2 for usage errors and a bad impd url
  ([2f34047](https://github.com/zgeoff/imp/commit/2f340470c361edbc3e362f8c97474e1b54004ec1))
- **cli:** harden host config, the token prompt and --host
  ([6807d78](https://github.com/zgeoff/imp/commit/6807d78ada93fe8caf7ded5a6e9754510b2d39e8))
- **cli:** harden the exec session core and its tests
  ([8a50226](https://github.com/zgeoff/imp/commit/8a502261999718fee7656b65fe7ef06ddeedf45b))
- **cli:** hide the arguments after -- from citty
  ([c839ceb](https://github.com/zgeoff/imp/commit/c839cebc31a3cc2ece59d17bb71b7f962503a664))
- **cli:** keep keys typed while a session attaches again
  ([4bd8f57](https://github.com/zgeoff/imp/commit/4bd8f573e2a0e09160171520572208c4ecac7820))
- **cli:** keep the impd url path prefix and fall back on an empty one
  ([4c1497c](https://github.com/zgeoff/imp/commit/4c1497c1a90953387cb62b0c3df3333cde54f3c9))
- **cli:** make exec and console robust
  ([f6a3a72](https://github.com/zgeoff/imp/commit/f6a3a723d1acb5f11808251fa2347de1224d4092)), closes
  [#42](https://github.com/zgeoff/imp/issues/42)
- **cli:** print the validation issues of a bad request
  ([1cb54ce](https://github.com/zgeoff/imp/commit/1cb54ce755c0ad738014effb0728ae6135e77504))
- **cli:** safer reattach, detach key forms and mode reset
  ([5775105](https://github.com/zgeoff/imp/commit/5775105d95eed5f5b102ae72383b4a801a8c8bf8))
- **cli:** validate arguments and make command output consistent
  ([bea70f4](https://github.com/zgeoff/imp/commit/bea70f45850bc5514eaf4eaedf12ede4d1e9c5c7))
- **daemon:** allow a zfs minor version skew with a warning
  ([cf8362a](https://github.com/zgeoff/imp/commit/cf8362a3dd604628cdc874afefbf0033fedab751))
- **daemon:** build the guest's ca bundle there and retry on failure
  ([38c1c1a](https://github.com/zgeoff/imp/commit/38c1c1a6f5d1c8bb66ae209f1db3f4849c60fedb))
- **daemon:** check the dns api url, the ca file and the test provider
  ([3fa10b8](https://github.com/zgeoff/imp/commit/3fa10b84ecc756ac69e95db094e9a85b0becd7c4))
- **daemon:** drop the snapshot a failed wake loaded
  ([054172f](https://github.com/zgeoff/imp/commit/054172f6959c2a87f1f2cc242d294afd4f122979))
- **daemon:** enforce sleeps every eligible imp when short of budget
  ([aa2ff6a](https://github.com/zgeoff/imp/commit/aa2ff6a086579fb8f0af4a62a0754e27d4a5bfed)), closes
  [#46](https://github.com/zgeoff/imp/issues/46)
- **daemon:** enforce sleeps every eligible imp when short of budget
  ([f69efb8](https://github.com/zgeoff/imp/commit/f69efb82e284e4b469fd57236a432853b0f1c34c)), closes
  [#46](https://github.com/zgeoff/imp/issues/46)
- **daemon:** find an existing acme account before making one
  ([8d1959b](https://github.com/zgeoff/imp/commit/8d1959bee5c266701ab058fc20a80475de338d77))
- **daemon:** harden the dashboard session against imps
  ([ba6f01c](https://github.com/zgeoff/imp/commit/ba6f01ca3bf62ef6100df977fdeac15c3d10e2b1))
- **daemon:** keep a woken vm that will not stop off the disk
  ([89d2e0a](https://github.com/zgeoff/imp/commit/89d2e0a76a1e8074883f8a449a876c782f8ba2cf))
- **daemon:** keep frozen guests out of the zfs reclaim queue
  ([1f9ee54](https://github.com/zgeoff/imp/commit/1f9ee54dd5a2aaf83c49c03cbdcf7abf768590ba))
- **daemon:** never replace a dns record impd did not make
  ([a437046](https://github.com/zgeoff/imp/commit/a437046b9c9b24b4dfbd9ab49e385f92bffa3d46))
- **daemon:** pass the session to the api on the bare domain
  ([69beef4](https://github.com/zgeoff/imp/commit/69beef4997110090858cdad65fcad0f22f5c8699))
- **daemon:** reconcile a creating imp whose vm will not stop
  ([ee4998e](https://github.com/zgeoff/imp/commit/ee4998ead2b044a4260d5cc5cb74faeb627f5034))
- **daemon:** refuse a session on an agent from before sessions
  ([8f4de56](https://github.com/zgeoff/imp/commit/8f4de56e2c17d1bab39dd7772b5d26085471e02f))
- **daemon:** repair crashed image builds and write the marker late
  ([b609842](https://github.com/zgeoff/imp/commit/b609842e07f5be1929299c74fae8e698fa531bf3))
- **daemon:** report an old agent as outdated for every session op
  ([4fd846b](https://github.com/zgeoff/imp/commit/4fd846bd74c676650fe180615fdcf5b19b59a427))
- **daemon:** reuse the acme account by its stored url
  ([53d9895](https://github.com/zgeoff/imp/commit/53d989539ecf3487f57611954fb2045e9b74e30c))
- **daemon:** wait for a zfs reclaim at shutdown and in tests
  ([c03e603](https://github.com/zgeoff/imp/commit/c03e603f95d21050103fb67c2a3abf037f92fc61))
- **dashboard:** clear state on logout and follow an ended session
  ([ad18360](https://github.com/zgeoff/imp/commit/ad183604e51202e09829deb45f9dc691b6cb1b03))
- **dashboard:** never redirect from an unmounted console
  ([fe3a999](https://github.com/zgeoff/imp/commit/fe3a999dffbb998886ac9678c419ca37b9995755))
- **deploy:** stop upgrade.sh when listing imps fails
  ([7689ac2](https://github.com/zgeoff/imp/commit/7689ac240104936dce0761b00ef5ad6afd178bfd))
- **deps:** ignore a node-forge advisory that impd never hits
  ([34fdb45](https://github.com/zgeoff/imp/commit/34fdb45cfd6a8ece49968f80390162fdf535f2d5)), closes
  [#16](https://github.com/zgeoff/imp/issues/16)
- **host:** check guest sources per tap; keep the broker to guests
  ([1c051ee](https://github.com/zgeoff/imp/commit/1c051ee14333da3a07e4e1cb69b73085c83c0104))
- **host:** install dev dependencies in the release compile stage
  ([289fcd8](https://github.com/zgeoff/imp/commit/289fcd889ddd204b4f5645ff8ef71861a5f397d8)), closes
  [#7](https://github.com/zgeoff/imp/issues/7)
- **mcp:** answer a cancelled create, fork or restore
  ([badc37a](https://github.com/zgeoff/imp/commit/badc37adee35496ba98cb8b3f3d54e6558515fd2))
- **mcp:** keep utf-8 characters whole at the output cut
  ([85bcbd8](https://github.com/zgeoff/imp/commit/85bcbd8708a01f42a2dfe79b4fd1b5196bcbf19a))
- **mcp:** kill what is left of a stopped command's group
  ([2f9e0af](https://github.com/zgeoff/imp/commit/2f9e0afedd3ed7181756f1eab0d3984d9b5bbfc1))
- **mcp:** write through symlinks and refuse directories
  ([1da7654](https://github.com/zgeoff/imp/commit/1da7654bc3d5a9869a41675b43e0613789125e8f))
- **net:** drop non-guest broker traffic in raw prerouting
  ([418862c](https://github.com/zgeoff/imp/commit/418862c0da79241f52090aadd75dcbb3a7c53a9a))
- **release:** keep the tap token out of git config, fail on bad binaries
  ([88efc46](https://github.com/zgeoff/imp/commit/88efc4604c26451ed4c47a3abb511df8b5e6943c))
- **release:** make the binary executable before brew runs it
  ([a218b8d](https://github.com/zgeoff/imp/commit/a218b8d83c7b540067864f7faa79383a8ad2f6fe))
- **scripts:** destroy zfs test pools by force and keep stuck files
  ([671381c](https://github.com/zgeoff/imp/commit/671381c8d190241806d4ca4916bf1712d6a7156a))
- show an agent error's code once, and rebuild the dev drive on up
  ([65d3256](https://github.com/zgeoff/imp/commit/65d32565a16f025a6d2a3b463fc6358cd4b7fc47))
