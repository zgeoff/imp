# Changelog

## [0.40.1](https://github.com/zgeoff/imp/compare/v0.40.0...v0.40.1) (2026-10-07)

### Bug Fixes

- **geo-135:** wait for the leader's trap before sending sigusr1
  ([#245](https://github.com/zgeoff/imp/issues/245))
  ([3aa85bb](https://github.com/zgeoff/imp/commit/3aa85bb4b0e00bcce1233092077bee28ed9723a2))

## [0.40.0](https://github.com/zgeoff/imp/compare/v0.39.0...v0.40.0) (2026-10-07)

### Features

- **broker:** send a custom secret's requests to a set upstream
  ([#236](https://github.com/zgeoff/imp/issues/236))
  ([a16a6ff](https://github.com/zgeoff/imp/commit/a16a6ffc19f5c7e8f3b08f3f54d9fe8f0e0ef978))

## [0.39.0](https://github.com/zgeoff/imp/compare/v0.38.1...v0.39.0) (2026-10-07)

### Features

- **broker:** add a refreshing oauth secret kind ([#235](https://github.com/zgeoff/imp/issues/235))
  ([f625b1a](https://github.com/zgeoff/imp/commit/f625b1a6ffd10f5e1c023a8cb40555119788399a))

## [0.38.1](https://github.com/zgeoff/imp/compare/v0.38.0...v0.38.1) (2026-10-06)

### Bug Fixes

- **images:** leave no work directory when docker create fails
  ([#227](https://github.com/zgeoff/imp/issues/227))
  ([9353e10](https://github.com/zgeoff/imp/commit/9353e10776cf6283d2b2f05f851caf91060799dd))

## [0.38.0](https://github.com/zgeoff/imp/compare/v0.37.0...v0.38.0) (2026-10-06)

### ⚠ BREAKING CHANGES

- **images:** releases no longer publish ghcr.io/zgeoff/imp-coder, and the repo no longer has
  images/dev. Published imp-coder tags stay on GHCR.

### Features

- **images:** publish imp-base as the only image ([#226](https://github.com/zgeoff/imp/issues/226))
  ([461ff88](https://github.com/zgeoff/imp/commit/461ff882840e88b9e6d9fbbc6032118f5d8840e1))

## [0.37.0](https://github.com/zgeoff/imp/compare/v0.36.0...v0.37.0) (2026-10-06)

### ⚠ BREAKING CHANGES

- **images:** under the default IMP_BUILD_ISOLATION=imp, imp image add pulls in a builder imp from a
  public registry, so an image that only the host's Docker engine has (such as one from a plain
  docker build) no longer adds; build it with imp image build, or set IMP_BUILD_ISOLATION=host for
  this release. Private registries do not pull in a builder.

### Bug Fixes

- **images:** drop a build's rootfs when its row fails or is cancelled
  ([#203](https://github.com/zgeoff/imp/issues/203))
  ([3bddbac](https://github.com/zgeoff/imp/commit/3bddbacb2afd2f5623947452cb977aa2eec60e6b))

## [0.36.0](https://github.com/zgeoff/imp/compare/v0.35.0...v0.36.0) (2026-10-06)

### ⚠ BREAKING CHANGES

- **images:** under the default IMP_BUILD_ISOLATION=imp, imp image add pulls in a builder imp from a
  public registry, so an image that only the host's Docker engine has (such as one from a plain
  docker build) no longer adds; build it with imp image build, or set IMP_BUILD_ISOLATION=host for
  this release. Private registries do not pull in a builder.
- **images:** under the default IMP_BUILD_ISOLATION=imp, imp image add pulls in a builder imp from a
  public registry, so an image that only the host's Docker engine has (such as one from a plain
  docker build) no longer adds; build it with imp image build, or set IMP_BUILD_ISOLATION=host for
  this release. Private registries do not pull in a builder.

### Features

- **images:** pull added images in a disposable builder imp
  ([#198](https://github.com/zgeoff/imp/issues/198))
  ([ca6dc4d](https://github.com/zgeoff/imp/commit/ca6dc4d55fb2028433e8bc668a4ebc5cbf9e3662))

### Bug Fixes

- **images:** time out the builder image pull, and let callers leave it
  ([#201](https://github.com/zgeoff/imp/issues/201))
  ([c8f7504](https://github.com/zgeoff/imp/commit/c8f7504c80f346b84a220eb3d14389434ca20f7f))

## [0.35.0](https://github.com/zgeoff/imp/compare/v0.34.0...v0.35.0) (2026-10-06)

### Features

- **egress:** a public egress policy that reaches the internet only
  ([#180](https://github.com/zgeoff/imp/issues/180))
  ([9a5b63b](https://github.com/zgeoff/imp/commit/9a5b63b65a8ad2abe2be6fc21f06aba270141c10))
- **images:** build images in a disposable builder imp
  ([#194](https://github.com/zgeoff/imp/issues/194))
  ([b29b883](https://github.com/zgeoff/imp/commit/b29b8832c4b6274f3749d4af47de24ecfe435b92))

## [0.34.0](https://github.com/zgeoff/imp/compare/v0.33.0...v0.34.0) (2026-10-06)

### Features

- **tokens:** change a token's grantable list without a new secret
  ([#221](https://github.com/zgeoff/imp/issues/221))
  ([da3b8a0](https://github.com/zgeoff/imp/commit/da3b8a001bb91f824365ba190cf197956165b72e))

## [0.33.0](https://github.com/zgeoff/imp/compare/v0.32.2...v0.33.0) (2026-10-06)

### Features

- **images:** add gh to the coder image ([#218](https://github.com/zgeoff/imp/issues/218))
  ([3f3a053](https://github.com/zgeoff/imp/commit/3f3a053f9603b13e3b4afc433fd257b6bdfcecd0))

### Bug Fixes

- **deps:** pin source-map-js 1.2.2 past its advisory
  ([#219](https://github.com/zgeoff/imp/issues/219))
  ([1c6e7ad](https://github.com/zgeoff/imp/commit/1c6e7ad9014776b534893d0e906d4e763ae847de))

## [0.32.2](https://github.com/zgeoff/imp/compare/v0.32.1...v0.32.2) (2026-10-04)

### Bug Fixes

- **client:** send large stdin in small frames, and keep a fast command's exit
  ([#216](https://github.com/zgeoff/imp/issues/216))
  ([ed5e36a](https://github.com/zgeoff/imp/commit/ed5e36a3dadccd11930fc7fa131e6e840c3ebb54))

## [0.32.1](https://github.com/zgeoff/imp/compare/v0.32.0...v0.32.1) (2026-10-04)

### Bug Fixes

- **images:** let a build stay silent past 360 s on the way to the engine
  ([#213](https://github.com/zgeoff/imp/issues/213))
  ([935b064](https://github.com/zgeoff/imp/commit/935b064371011eb9b74175fc876d24e762f9085f))

## [0.32.0](https://github.com/zgeoff/imp/compare/v0.31.0...v0.32.0) (2026-10-04)

### Features

- **sessions:** opt-in durable output logs, kept on the host
  ([#178](https://github.com/zgeoff/imp/issues/178))
  ([724ffa2](https://github.com/zgeoff/imp/commit/724ffa230bf2d6d215a33342b93661980942bcee))

### Bug Fixes

- **daemon:** keep stale session log work off a re-created imp's logs
  ([#197](https://github.com/zgeoff/imp/issues/197))
  ([36edfa8](https://github.com/zgeoff/imp/commit/36edfa8ee28bf976c71f8d8b0e18a2ff21dc54aa))

## [0.31.0](https://github.com/zgeoff/imp/compare/v0.30.0...v0.31.0) (2026-10-04)

### Features

- **mcp:** an OAuth sign-in for a default-off public /mcp route
  ([#190](https://github.com/zgeoff/imp/issues/190))
  ([4b92ed3](https://github.com/zgeoff/imp/commit/4b92ed3cd8053b3f63b04b62162b3ab783e13120))

## [0.30.0](https://github.com/zgeoff/imp/compare/v0.29.1...v0.30.0) (2026-10-04)

### Features

- **images:** publish imp-coder, a small image for running a coding agent
  ([#176](https://github.com/zgeoff/imp/issues/176))
  ([f7bfd1b](https://github.com/zgeoff/imp/commit/f7bfd1b47defa7f5fa5b3ddcde951049ee27b89b))
- **ops:** copy the database safely while impd runs, and document a restore
  ([#184](https://github.com/zgeoff/imp/issues/184))
  ([e29ea05](https://github.com/zgeoff/imp/commit/e29ea05de8250a02b958140b1183082910ee026c))

### Bug Fixes

- **agent:** keep reading host frames after an exec's session ends
  ([#187](https://github.com/zgeoff/imp/issues/187))
  ([282a085](https://github.com/zgeoff/imp/commit/282a085f861bf8840150e49572ad9a7effa36810))
- **egress:** keep impd up when a resolver socket gets a refusal
  ([#193](https://github.com/zgeoff/imp/issues/193))
  ([f516cc0](https://github.com/zgeoff/imp/commit/f516cc00252f6944641d578ebf183078b54b5636))
- **https:** warn when the public ip is not an internet address
  ([#192](https://github.com/zgeoff/imp/issues/192))
  ([f344390](https://github.com/zgeoff/imp/commit/f3443907363b59e21753532ba0db1499310ea8f2))
- **images:** a docker proxy refusal reaches the client as BAD_REQUEST
  ([#179](https://github.com/zgeoff/imp/issues/179))
  ([0f080a2](https://github.com/zgeoff/imp/commit/0f080a2db45e6579e854cacc588cf878eef554da))
- **images:** stream build events so a long build outlives the fetch
  ([#174](https://github.com/zgeoff/imp/issues/174))
  ([73de198](https://github.com/zgeoff/imp/commit/73de19871a4e6bfe198859a91ed15c80424daff0)), closes
  [#162](https://github.com/zgeoff/imp/issues/162)
- **images:** stream images.add and on-host builds past fetch timeouts
  ([#181](https://github.com/zgeoff/imp/issues/181))
  ([f1b42a8](https://github.com/zgeoff/imp/commit/f1b42a8f1b5d6ddf83ccd5a38ae1f93ad140f527))
- **security:** a scoped token's fork copies only the grants it could make
  ([#172](https://github.com/zgeoff/imp/issues/172))
  ([eef2ec8](https://github.com/zgeoff/imp/commit/eef2ec8dd50580820650e7aecce6927758c7c069))
- **storage:** count disk usage after stops, sleeps and resizes
  ([#166](https://github.com/zgeoff/imp/issues/166))
  ([dce9a74](https://github.com/zgeoff/imp/commit/dce9a742c27836c22e90075b2e0577f41f838be8))
- **storage:** count disk usage when a move lands ([#183](https://github.com/zgeoff/imp/issues/183))
  ([3223f05](https://github.com/zgeoff/imp/commit/3223f0528949c479712a85ed5c3147b5e165d29d))

## [0.29.1](https://github.com/zgeoff/imp/compare/v0.29.0...v0.29.1) (2026-10-04)

### Bug Fixes

- **images:** write image.json without following links in the image
  ([#196](https://github.com/zgeoff/imp/issues/196))
  ([3d4541a](https://github.com/zgeoff/imp/commit/3d4541a1a25b5d1238050bfb5b9efc7c172ea884))

## [0.29.0](https://github.com/zgeoff/imp/compare/v0.28.1...v0.29.0) (2026-10-03)

### ⚠ BREAKING CHANGES

- **images:** imp image build refuses a Dockerfile with a variable ($) in FROM, such as FROM
  ${BASE}; write the base image literally.

### Features

- **images:** build with BuildKit through the socket proxy, bound to inspected images
  ([#163](https://github.com/zgeoff/imp/issues/163))
  ([51df459](https://github.com/zgeoff/imp/commit/51df459d63b85426e419294b3410fe10a3bf7c64))

## [0.28.1](https://github.com/zgeoff/imp/compare/v0.28.0...v0.28.1) (2026-10-03)

### Bug Fixes

- **images:** build dev and hello on the published base by digest
  ([#160](https://github.com/zgeoff/imp/issues/160))
  ([e73c42b](https://github.com/zgeoff/imp/commit/e73c42b54965255d53d882f40bb2650a8484613c))

## [0.28.0](https://github.com/zgeoff/imp/compare/v0.27.0...v0.28.0) (2026-10-03)

### Features

- **release:** publish the imp base image to ghcr ([#158](https://github.com/zgeoff/imp/issues/158))
  ([4b3f4fc](https://github.com/zgeoff/imp/commit/4b3f4fc940b95b043da3efded10d3c5fec54a29d))

## [0.27.0](https://github.com/zgeoff/imp/compare/v0.26.2...v0.27.0) (2026-10-03)

### Features

- **security:** let scoped tokens manage selected secret grants
  ([#154](https://github.com/zgeoff/imp/issues/154))
  ([9145ae6](https://github.com/zgeoff/imp/commit/9145ae68e1afc2cb4a4f6775e50466cce4e06ae1))

### Bug Fixes

- **deploy:** run the image of the deploy files' own release
  ([#153](https://github.com/zgeoff/imp/issues/153))
  ([a84a70c](https://github.com/zgeoff/imp/commit/a84a70cf4147ad2e1d76ccbd1c17780d663f09d5))

## [0.26.2](https://github.com/zgeoff/imp/compare/v0.26.1...v0.26.2) (2026-10-03)

### Bug Fixes

- **docker-proxy:** refuse a build body that is not a tar context
  ([#150](https://github.com/zgeoff/imp/issues/150))
  ([3323f96](https://github.com/zgeoff/imp/commit/3323f968dd4f2d2de6e537d83f9f5a47e44490af))
- **images:** keep file capabilities in an image ([#152](https://github.com/zgeoff/imp/issues/152))
  ([4afacf9](https://github.com/zgeoff/imp/commit/4afacf9a83fe46668b890d4fa5bfdf2c497055fa))
- **templates:** wait for the disk clone before a jailed restore
  ([#151](https://github.com/zgeoff/imp/issues/151))
  ([6ead887](https://github.com/zgeoff/imp/commit/6ead8870e7c7af11b63036c61c73c811a1d0449d))

## [0.26.1](https://github.com/zgeoff/imp/compare/v0.26.0...v0.26.1) (2026-10-03)

### Bug Fixes

- **deploy:** default the nixos module's image to its own release
  ([#142](https://github.com/zgeoff/imp/issues/142))
  ([b90d094](https://github.com/zgeoff/imp/commit/b90d094649ca088ed55a4d5cdaa4586c26eab9ae))
- **dev:** give each worktree its own dev image tag
  ([#139](https://github.com/zgeoff/imp/issues/139))
  ([7f8cd32](https://github.com/zgeoff/imp/commit/7f8cd326bb8d7808cfe5a1b130bb7d17d4321da6))

## [0.26.0](https://github.com/zgeoff/imp/compare/v0.25.1...v0.26.0) (2026-10-03)

### Features

- **https:** read the dns api token from a file, and re-read it on use
  ([#136](https://github.com/zgeoff/imp/issues/136))
  ([4601047](https://github.com/zgeoff/imp/commit/46010472ee3ba26965d9ffef6d97bd84be92a6a1))

### Bug Fixes

- **moves:** respect leases when a move stops an imp, and carry them to the target
  ([#137](https://github.com/zgeoff/imp/issues/137))
  ([06ae2e9](https://github.com/zgeoff/imp/commit/06ae2e98fdfacb6f09353b75a6c035f2464a62f0))

## [0.25.1](https://github.com/zgeoff/imp/compare/v0.25.0...v0.25.1) (2026-10-03)

### Bug Fixes

- **dev:** replace a changed docker proxy on up and restart
  ([8d7723c](https://github.com/zgeoff/imp/commit/8d7723cb4441c55269ef5679d4a2eb6e996da5d9))

## [0.25.0](https://github.com/zgeoff/imp/compare/v0.24.0...v0.25.0) (2026-10-03)

### Features

- **daemon:** add imp-docker-proxy, a filtering docker socket proxy
  ([8aaad24](https://github.com/zgeoff/imp/commit/8aaad24bb895a926a1437eda8594b38d378bbb75))
- **deploy:** reach docker through imp-docker-proxy, not the host socket
  ([3b9a784](https://github.com/zgeoff/imp/commit/3b9a784e6d36e0cb82af42b780d2fd48386db169))

### Bug Fixes

- **daemon:** require a tag on a pull through the proxy
  ([b42698e](https://github.com/zgeoff/imp/commit/b42698e3a8d5eec2a2898db8933de80bac0681b2))
- **deploy:** check the image label before bootstrap writes anything
  ([2931f67](https://github.com/zgeoff/imp/commit/2931f67121795ff3b0a65c9609beed77562e007f))

## [0.24.0](https://github.com/zgeoff/imp/compare/v0.23.0...v0.24.0) (2026-10-03)

### Features

- **daemon:** report the work before a sleep's duration in the event
  ([0c3772e](https://github.com/zgeoff/imp/commit/0c3772e698abd9d57871633e9c9e87f3e7e54960))

## [0.23.0](https://github.com/zgeoff/imp/compare/v0.22.0...v0.23.0) (2026-10-03)

### Features

- **cli:** say in imp info when cgroup limits are off
  ([20e82ec](https://github.com/zgeoff/imp/commit/20e82ec4a2194716a9a0b670d21650662769982a)), closes
  [#75](https://github.com/zgeoff/imp/issues/75)
- **deploy:** install the image's unit on upgrade, refuse a rollback
  ([5dc5392](https://github.com/zgeoff/imp/commit/5dc5392b6e47fb967a0a096269aee024d08249da)), closes
  [#75](https://github.com/zgeoff/imp/issues/75)
- **host:** run imp-host without --privileged
  ([4d12944](https://github.com/zgeoff/imp/commit/4d12944f314751e30105f1d6448de1dceab5f42b)), closes
  [#75](https://github.com/zgeoff/imp/issues/75)

### Bug Fixes

- **deploy:** stop an upgrade whose unit cannot be installed
  ([12afa32](https://github.com/zgeoff/imp/commit/12afa32bb6fc37109bf99d94dfeb57d2cb2db487)), closes
  [#75](https://github.com/zgeoff/imp/issues/75) [#75](https://github.com/zgeoff/imp/issues/75)
- **host:** check reflink by a clone, not xfs_info
  ([623d453](https://github.com/zgeoff/imp/commit/623d4531ecd8ccca80c6d52d7648f23024586e73)), closes
  [#75](https://github.com/zgeoff/imp/issues/75)

## [0.22.0](https://github.com/zgeoff/imp/compare/v0.21.0...v0.22.0) (2026-10-03)

### Features

- **agent:** the inner container's limit follows an elastic guest
  ([9557826](https://github.com/zgeoff/imp/commit/955782689084bdc4ee6e2ad040f721b5d22ae85a))
- **daemon:** elastic guest memory with virtio-mem hot-plug
  ([3cd36b6](https://github.com/zgeoff/imp/commit/3cd36b675a0270afa25f17da089253d4608bd904))
- **daemon:** no grow for an imp whose agent predates elastic memory
  ([2829924](https://github.com/zgeoff/imp/commit/2829924fbfc1b7d3542a857e3bb4c60632880271))
- **daemon:** the memory.max of each vm follows its elastic guest
  ([f250253](https://github.com/zgeoff/imp/commit/f25025367f2fb989491e8b8676cb563acd18633e))
- **moves:** a moved imp keeps its max memory
  ([ba7962e](https://github.com/zgeoff/imp/commit/ba7962e69b291bd9c8aa2a3227af6bb46a0dfc3d))

### Bug Fixes

- **moves:** start an imp again when the target refuses its max memory
  ([2ae98e5](https://github.com/zgeoff/imp/commit/2ae98e5ef9b6783a0cfcd31521ac76a5bcb87bdf)), closes
  [#35](https://github.com/zgeoff/imp/issues/35)

## [0.21.0](https://github.com/zgeoff/imp/compare/v0.20.0...v0.21.0) (2026-10-02)

### Features

- **daemon:** let ksm merge guest memory when the host opts in
  ([2c488d0](https://github.com/zgeoff/imp/commit/2c488d04071c8b45bc151198d4c9fa9a0c554b77))
- **daemon:** log an adopted vm that keeps the ksm flag with ksm off
  ([4399bc6](https://github.com/zgeoff/imp/commit/4399bc6ea8feb33767dd7bc588ef2a086d415b35))
- **deploy:** add bootstrap --ksm for bare-metal hosts
  ([3ad5bdc](https://github.com/zgeoff/imp/commit/3ad5bdc916be51156fba1de1f39fb4b9ad631628))
- **deploy:** add bootstrap --no-ksm
  ([6162034](https://github.com/zgeoff/imp/commit/61620343e108201418905a325fa1cbf5713039f7))
- **host:** add ksm-exec to start firecracker mergeable
  ([e25bc7f](https://github.com/zgeoff/imp/commit/e25bc7ffa3e4ed5a0a0670f6a1617efc7c9cd7c6))

### Bug Fixes

- **daemon:** check a restore's split guest memory whole on 6.10-6.11
  ([60c9c17](https://github.com/zgeoff/imp/commit/60c9c179c22b3bb30a22850eddb53f9b11423d15))
- **daemon:** keep ksm headroom from the vms' own profit
  ([437a723](https://github.com/zgeoff/imp/commit/437a7230c277e5ed0214f04401e27f3b82a96780))
- **deploy:** unmerge ksm's pages on --no-ksm
  ([b32b440](https://github.com/zgeoff/imp/commit/b32b44001e344b83e99a5f15ea691fa3bcd20dfc))

## [0.20.0](https://github.com/zgeoff/imp/compare/v0.19.0...v0.20.0) (2026-10-02)

### Features

- **cli:** list the imps on every saved host with imp ls --all
  ([781b113](https://github.com/zgeoff/imp/commit/781b1134e2d9d292d3a3a2c950e86e572cf635b2))
- **cli:** place a new imp on the saved host with the most free ram
  ([75b9a58](https://github.com/zgeoff/imp/commit/75b9a58f615db30da3a544810969a59c02b41560))
- **cli:** show an imp's move mark in the note column
  ([b8030ae](https://github.com/zgeoff/imp/commit/b8030ae2dea3560a8898cf4237e70ec245844119))
- **cli:** show the create defaults and egress enforcement in imp info
  ([2753080](https://github.com/zgeoff/imp/commit/2753080514fc68d11b2295e1dffbf6f3720b074d))
- **cli:** show the sleeping imps' memory in imp info
  ([e116b2d](https://github.com/zgeoff/imp/commit/e116b2d5725be1a80c6d7eddd43c2d55c1fb7181))
- **daemon:** report sleeping memory, defaults and egress in system.info
  ([b2b4bf5](https://github.com/zgeoff/imp/commit/b2b4bf5dc8910d6d594214df79d5b418c44a91f0))

### Bug Fixes

- **cli:** abort a host's open requests when its call ends
  ([2129255](https://github.com/zgeoff/imp/commit/2129255e3b6855cdbce20dcc0951eb0c01e87324))
- **cli:** name the host after a placed create fails; keep ls --all hosts
  ([0cd24d9](https://github.com/zgeoff/imp/commit/0cd24d96fa601c2db8b353be05d197f5a2c1a239))

## [0.19.0](https://github.com/zgeoff/imp/compare/v0.18.0...v0.19.0) (2026-10-02)

### Features

- **daemon:** boot cold when the cpu changed since the sleep
  ([3a41dde](https://github.com/zgeoff/imp/commit/3a41ddec4956ecdda1f9bf030ba99c6c3839a49c))
- **daemon:** give each new tap a mac derived from its slot
  ([4164e20](https://github.com/zgeoff/imp/commit/4164e2007aaa2ef81865820d9387581b7941837e))
- **daemon:** let a move ticket keep a slot for the imp it brings
  ([24b6642](https://github.com/zgeoff/imp/commit/24b664206de141fb01efa831e95463c7630e076f))
- **daemon:** move a sleeping imp with its memory
  ([9f2646e](https://github.com/zgeoff/imp/commit/9f2646efd8f9352ad81f41bc2f2fbf0fde0bb78d))
- **e2e:** drive a second dev instance beside the run's own
  ([e504444](https://github.com/zgeoff/imp/commit/e50444433a77a6b7e97de94cc70786310cd65079))

### Bug Fixes

- **daemon:** carry an imp's cold boots in a move
  ([a643b8f](https://github.com/zgeoff/imp/commit/a643b8f2f992f8f412527568c89a93fa0020d5a0))
- **daemon:** check the cold boots a move carries
  ([241ea32](https://github.com/zgeoff/imp/commit/241ea32c75f664d7bf7d811fd3899b6c0ce2155d))
- **daemon:** close the warm move review's gaps
  ([a7a140c](https://github.com/zgeoff/imp/commit/a7a140ca7ea731d03832f7498aa55d3d32d27c54))
- **daemon:** fit boot templates to the cpu facts and slot macs
  ([60c17ff](https://github.com/zgeoff/imp/commit/60c17ff64e44050f835fa4949ff9155016d06025))
- **daemon:** free a refused stream's slot, keep moving imps off nets
  ([7b5d364](https://github.com/zgeoff/imp/commit/7b5d3644a2c85d8d5a838ace7e9bdcf5393fe29c))
- **daemon:** join a network under the imp's lock, after
  [#27](https://github.com/zgeoff/imp/issues/27)'s migration
  ([b5d4e37](https://github.com/zgeoff/imp/commit/b5d4e372e60ac0255ae3272fdfc9aab8560a1bef))
- **daemon:** keep move test settings from opening moves off the tailnet
  ([2c42220](https://github.com/zgeoff/imp/commit/2c42220038c02879aa9c6762838de11fbb4ca09b))
- **daemon:** key boot templates to the cpu they were made on
  ([97c40ee](https://github.com/zgeoff/imp/commit/97c40eee6a16cd1db220c5633530462396c29a27))
- **daemon:** refuse a warm move for an imp on a private network
  ([59fb2f5](https://github.com/zgeoff/imp/commit/59fb2f509014d573c69a9f379378f9cbc6333a6f))
- **daemon:** refuse a warm move from an imp whose tap is gone
  ([5b1c41e](https://github.com/zgeoff/imp/commit/5b1c41e5dbb542f742d91a901a1a5e224ec1f4ee))

## [0.18.0](https://github.com/zgeoff/imp/compare/v0.17.0...v0.18.0) (2026-10-02)

### Features

- **daemon:** jail boot template builds and restores
  ([4fe2847](https://github.com/zgeoff/imp/commit/4fe2847f8a6e22b4655523928aa215c428692451))
- **daemon:** run each vm under the firecracker jailer
  ([e87662d](https://github.com/zgeoff/imp/commit/e87662d1334e2db67069afd076c13a8f7cafdd53))

## [0.17.0](https://github.com/zgeoff/imp/compare/v0.16.0...v0.17.0) (2026-10-02)

### Features

- **agent:** output offsets, generations and resume for sessions
  ([c42c8c1](https://github.com/zgeoff/imp/commit/c42c8c1c7e892a9294a0a7314208f73748d87a25))
- **api:** session output offsets, resume and cold boots on /exec
  ([98f2a51](https://github.com/zgeoff/imp/commit/98f2a515e2012c996b5d8c3174859b3c18d077a8))
- **client:** resume sessions and type their errors
  ([fbfc8d0](https://github.com/zgeoff/imp/commit/fbfc8d003b7cf1734f549393c468f4ee32755334))
- **daemon:** carry session offsets, resume and cold-boot causes
  ([40bc10a](https://github.com/zgeoff/imp/commit/40bc10ae213547fc0bc501bf522c168d98205fd4))

## [0.16.0](https://github.com/zgeoff/imp/compare/v0.15.0...v0.16.0) (2026-10-02)

### Features

- **daemon:** move a stopped imp to another host
  ([1adc0f3](https://github.com/zgeoff/imp/commit/1adc0f37ce94a43a1fa0bfa82e60eea801ee5528))
- **daemon:** move imps from a zfs host
  ([88bb12b](https://github.com/zgeoff/imp/commit/88bb12b40a240b49cff5512374de14f8b5dee0fd))

### Bug Fixes

- **cli:** point at --abort when a failed send leaves the mark on
  ([ed8d7b1](https://github.com/zgeoff/imp/commit/ed8d7b1f9e09b8e189f367a5aa66d1f67915d66e))
- **daemon:** close the review's gaps in moves
  ([9888012](https://github.com/zgeoff/imp/commit/98880122087da131b9ed3ecdf5251731e51761f7))
- **daemon:** hash zfs move streams before recv can commit them
  ([70f6f69](https://github.com/zgeoff/imp/commit/70f6f69fff90aa192ecafb40c52106c5c8bd9e4d))
- **daemon:** hold a received move snapshot until setup destroys it
  ([4d8a04b](https://github.com/zgeoff/imp/commit/4d8a04b675aed8a11254149b02091cbefcd391c4)), closes
  [#40](https://github.com/zgeoff/imp/issues/40)
- **daemon:** keep template state and refuse public imps in moves
  ([579bec1](https://github.com/zgeoff/imp/commit/579bec156533979de73b02238cf4c94dcd112f64))

## [0.15.0](https://github.com/zgeoff/imp/compare/v0.14.0...v0.15.0) (2026-10-02)

### Features

- **api:** add the leases contract, the leased error and capacity data
  ([bb1aa0f](https://github.com/zgeoff/imp/commit/bb1aa0f5d2080d922ce5fa232e99e6892a4b87ef))
- **cli:** force imp sleep and imp stop past an imp's leases
  ([bfd4429](https://github.com/zgeoff/imp/commit/bfd44290840c0b2ac9351c8aebb4467fe6bd4d76))
- **daemon:** derive a lease principal for each caller
  ([11a3490](https://github.com/zgeoff/imp/commit/11a34903f94ae7d0c7502ea090237edfd313eea2))
- **daemon:** serve leases, refuse leased sleeps and name protected imps
  ([d1e475d](https://github.com/zgeoff/imp/commit/d1e475d7a673bd76a120a5de02e26bdd8bcb33bf))
- **daemon:** store each owner's leases in imp_leases
  ([31c5895](https://github.com/zgeoff/imp/commit/31c58958dda8917b53b185054f7c071cdc830463))

### Bug Fixes

- **daemon:** end forced leases after the sleep, and pass no-op sleeps
  ([e7fc0f9](https://github.com/zgeoff/imp/commit/e7fc0f99ebfd0d49f6d38e264c45e5f6e72c5078)), closes
  [#96](https://github.com/zgeoff/imp/issues/96)
- **daemon:** give a tagged node with no stable id no lease principal
  ([e5b6579](https://github.com/zgeoff/imp/commit/e5b657982268bc5da9a8813473c4da3a69f9970a))

## [0.14.0](https://github.com/zgeoff/imp/compare/v0.13.1...v0.14.0) (2026-10-02)

### Features

- **deploy:** add ipv6 and forward rules to the nixos module
  ([bea47d4](https://github.com/zgeoff/imp/commit/bea47d451284162f7deae4c268c5579afba0ad27)), closes
  [#84](https://github.com/zgeoff/imp/issues/84)
- **deploy:** run imp-host on an ipv6 docker network from bootstrap.sh
  ([1910f0f](https://github.com/zgeoff/imp/commit/1910f0f1b265d1813522dd8091abdb69a476bdf8)), closes
  [#84](https://github.com/zgeoff/imp/issues/84)

### Bug Fixes

- **deploy:** clear imp-host's start limit before a restart
  ([337138f](https://github.com/zgeoff/imp/commit/337138fa8d6c07bb6d9c21769d97745ef7e7552e)), closes
  [#84](https://github.com/zgeoff/imp/issues/84)
- **deploy:** import the pool by partuuid on virtio hosts
  ([977d3fc](https://github.com/zgeoff/imp/commit/977d3fcb59ad089c180e674da7b8c6692e6957b6))
- **deploy:** let auto stay off when a client owns router adverts
  ([d6e5817](https://github.com/zgeoff/imp/commit/d6e5817cf9a2feec6db03cc69c039fa608f0f701)), closes
  [#84](https://github.com/zgeoff/imp/issues/84)
- **deploy:** narrow the module's forward rules and check its ipv6 setup
  ([a65435a](https://github.com/zgeoff/imp/commit/a65435a91b050e244589c113aa17f713726847c5)), closes
  [#84](https://github.com/zgeoff/imp/issues/84)
- **storage:** keep checkpoints no row names, and log staging and reclaim
  ([9d75618](https://github.com/zgeoff/imp/commit/9d75618ad269d23a715bcf406ad7037f642ba5ea)), closes
  [#90](https://github.com/zgeoff/imp/issues/90)
- **storage:** keep disks and images the database does not name
  ([695e2f3](https://github.com/zgeoff/imp/commit/695e2f3fb78b2a12f7458c70c79cc4ba3e4dabf8)), closes
  [#90](https://github.com/zgeoff/imp/issues/90)
- **storage:** keep the memory snapshots and images no row names
  ([cb67df1](https://github.com/zgeoff/imp/commit/cb67df185230df2bf7c8c0e4e5e13b7efea99d1b)), closes
  [#90](https://github.com/zgeoff/imp/issues/90)
- **storage:** take an image's [@base](https://github.com/base) in staging, before its rename
  ([22ac88f](https://github.com/zgeoff/imp/commit/22ac88faca8f0321532990568c6dcfaaf9a7b3da)), closes
  [#90](https://github.com/zgeoff/imp/issues/90) [#90](https://github.com/zgeoff/imp/issues/90)

## [0.13.1](https://github.com/zgeoff/imp/compare/v0.13.0...v0.13.1) (2026-10-02)

### Bug Fixes

- **daemon:** drop an invalid event from the stream, not every stream
  ([eb817fb](https://github.com/zgeoff/imp/commit/eb817fb5a5b240b02a3af9b78b5a1dcca5681557))
- **daemon:** name a slept imp from the governor's pick
  ([f577f86](https://github.com/zgeoff/imp/commit/f577f86f9cea31845327a1e1ba4fb6510ceda073))

## [0.13.0](https://github.com/zgeoff/imp/compare/v0.12.0...v0.13.0) (2026-10-02)

### Features

- **cli:** imp net and imp new --net ([#31](https://github.com/zgeoff/imp/issues/31))
  ([6c4cde3](https://github.com/zgeoff/imp/commit/6c4cde3d5041388d4b0028a215db7a47c1c5b51e))
- **daemon:** backups carry an imp's networks; a fork joins none
  ([#31](https://github.com/zgeoff/imp/issues/31))
  ([bc69259](https://github.com/zgeoff/imp/commit/bc692590308af91efd03d50d25a4beec24a89693))
- **daemon:** firewall rules for imps on one network
  ([#31](https://github.com/zgeoff/imp/issues/31))
  ([a95dae2](https://github.com/zgeoff/imp/commit/a95dae22c61879ecf5967ea78b7f7df852fb9733))
- **daemon:** impd answers network names and never forwards them
  ([#31](https://github.com/zgeoff/imp/issues/31))
  ([239e3ad](https://github.com/zgeoff/imp/commit/239e3ad35d9266af838b7e7e0a0529a797533cf4))
- **daemon:** tables for networks and their members ([#31](https://github.com/zgeoff/imp/issues/31))
  ([6f140ae](https://github.com/zgeoff/imp/commit/6f140aee8bf2b005ba3ec3bc8d36668c5844f06a))
- **host:** accept marked traffic between imps on one network
  ([#31](https://github.com/zgeoff/imp/issues/31))
  ([d8145e7](https://github.com/zgeoff/imp/commit/d8145e769ae085ba0e049c388bbd3669ea42f794))
- networks api; a join or leave rebuilds the firewall
  ([#31](https://github.com/zgeoff/imp/issues/31))
  ([45c2e58](https://github.com/zgeoff/imp/commit/45c2e5808cbd3a7b2ce4dfd2725026cddf849685))
- trust warnings after imp policy and imp new --net ([#31](https://github.com/zgeoff/imp/issues/31))
  ([cab6d40](https://github.com/zgeoff/imp/commit/cab6d40e0d3125235d64417e5a75795e4a185144))

### Bug Fixes

- **daemon:** look again soon when a follow finds a running imp held
  ([d364b11](https://github.com/zgeoff/imp/commit/d364b110f59161272b34ec428cd63a39031e17a0))
- **daemon:** networks fail closed on a failed undo; join warns
  ([#31](https://github.com/zgeoff/imp/issues/31))
  ([2c9262e](https://github.com/zgeoff/imp/commit/2c9262ecbcb9e96fcd82b30f8564f1f17de525a4))
- **daemon:** retry a network undo; check forward on each apply
  ([#31](https://github.com/zgeoff/imp/issues/31))
  ([7570ca5](https://github.com/zgeoff/imp/commit/7570ca59d5dd8c7de4e2b8e0e871448e39b9ba9b))

## [0.12.0](https://github.com/zgeoff/imp/compare/v0.11.0...v0.12.0) (2026-10-02)

### Features

- a tool exec acks its stdout to bound the client's memory
  ([#24](https://github.com/zgeoff/imp/issues/24))
  ([b5e0fc8](https://github.com/zgeoff/imp/commit/b5e0fc85a9ae8577e97840d19c78ae5d26976642))
- **agent:** a cgroup per exec, so a stop kills escapees too
  ([9bbda74](https://github.com/zgeoff/imp/commit/9bbda74043617885c4fe760fd4bef137d986b573)), closes
  [#69](https://github.com/zgeoff/imp/issues/69)
- **agent:** detachable sessions with replay and mode tracking
  ([67fd3cf](https://github.com/zgeoff/imp/commit/67fd3cf68e004b7cdbc4609b25783823c09f78e0))
- **agent:** dial op and an sftp server for the ssh gateway
  ([d62d5d9](https://github.com/zgeoff/imp/commit/d62d5d9276b621cb634479f707d90c2cc3882a20))
- **agent:** give eth0 its ipv6 /128 and route via fe80::1
  ([#32](https://github.com/zgeoff/imp/issues/32))
  ([680d292](https://github.com/zgeoff/imp/commit/680d292387e0ad5e1d2fe940ea6f9fe4b6f32861))
- **agent:** grow the root filesystem to fill its disk
  ([22136ee](https://github.com/zgeoff/imp/commit/22136eebadfba55fae3a5b24263010c4f9a4cb9d))
- **agent:** imp-agent tar, the guest end of imp cp, at 0.7.0
  ([#24](https://github.com/zgeoff/imp/issues/24))
  ([360f460](https://github.com/zgeoff/imp/commit/360f460c44e5a3c2af06d1ec61dab87811d38ac5))
- **agent:** kill a stopped command's whole process group
  ([c2b7371](https://github.com/zgeoff/imp/commit/c2b7371f1a2f83b068fbd8c5b4a070beb032e4e1)), closes
  [#51](https://github.com/zgeoff/imp/issues/51)
- **agent:** kill what is left of a stopped exec's process group
  ([f245c56](https://github.com/zgeoff/imp/commit/f245c560e8ecc2493215c6ce4edfe4529f2d34cd))
- **agent:** listen serves reverse forwards as the user, at 0.9.0
  ([#64](https://github.com/zgeoff/imp/issues/64))
  ([67fcf4e](https://github.com/zgeoff/imp/commit/67fcf4eb31d6673e512b3d4034e5956ac10096f0))
- **agent:** serve ssh-agent forwarding sockets ([#53](https://github.com/zgeoff/imp/issues/53))
  ([cd978d7](https://github.com/zgeoff/imp/commit/cd978d7ea80cdadb1f40ee506f465f3fb2cf0c9e))
- an exec takes a kill grace and reports the agent's group kill
  ([fc3e3e8](https://github.com/zgeoff/imp/commit/fc3e3e8c43e2fe8ae0c25ac62caf740f70c575c5))
- **api:** add named tokens with scopes to the contract
  ([#29](https://github.com/zgeoff/imp/issues/29))
  ([31114b0](https://github.com/zgeoff/imp/commit/31114b0ae13099c5d9c5277861d3fbb66aa6a306))
- **api:** bind ssh keys to tokens in the contract ([#63](https://github.com/zgeoff/imp/issues/63))
  ([3e9a94a](https://github.com/zgeoff/imp/commit/3e9a94aa91d8c51502886aa344cceb0b7261111b))
- **api:** report the resident memory of each awake imp
  ([85d1e8a](https://github.com/zgeoff/imp/commit/85d1e8a6b29a32b6cb25a3c20566a2097581d2ca))
- **api:** tunnel websocket protocol for imp proxy ([#25](https://github.com/zgeoff/imp/issues/25))
  ([9d8625b](https://github.com/zgeoff/imp/commit/9d8625b3541cfe8ec9fcb056f53f402c511417f0))
- **backup:** keep disk sizes in the manifest
  ([0aafeda](https://github.com/zgeoff/imp/commit/0aafeda269929644945b6a7035c2a7869f454d12))
- **backup:** record each disk's used bytes, and restore by them
  ([db6fa76](https://github.com/zgeoff/imp/commit/db6fa7626748bc7cefaa36f174c1f57e48e3fab2))
- **broker:** tunnels dial public ipv6 when imps have it
  ([#32](https://github.com/zgeoff/imp/issues/32))
  ([188ab11](https://github.com/zgeoff/imp/commit/188ab116e90ff7c3c7cf7362720bc61f6ec8c848))
- **cli:** add imp backup ls, run, restore and check
  ([40973ce](https://github.com/zgeoff/imp/commit/40973cea863f91637cb58d1bfdc8da56f3c4bc64))
- **cli:** add imp events and imp audit --kind api ([#38](https://github.com/zgeoff/imp/issues/38))
  ([d740737](https://github.com/zgeoff/imp/commit/d7407372dbb4ff39f7411c2a8807f465bcc51a0f))
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
- **client:** let the caller open the exec socket
  ([35034b7](https://github.com/zgeoff/imp/commit/35034b7c9d8eebb7f1107604c4d1f83c4accf24f))
- **client:** reverse forwards relay imp clients to the caller
  ([#64](https://github.com/zgeoff/imp/issues/64))
  ([ce86e07](https://github.com/zgeoff/imp/commit/ce86e07514141e8420862cb3647d2ce2e0959bbf))
- **client:** upload a build context from the sdk
  ([0301c0d](https://github.com/zgeoff/imp/commit/0301c0d98e8d3d395cf9d5a7c35d1e0137e23cd5))
- **cli:** host profiles, completions, brew tap and install script
  ([529e866](https://github.com/zgeoff/imp/commit/529e8667cde32d2b7b4d57f03952329af2ce6619)), closes
  [#19](https://github.com/zgeoff/imp/issues/19)
- **cli:** imp cp copies into and out of an imp ([#24](https://github.com/zgeoff/imp/issues/24))
  ([64091f2](https://github.com/zgeoff/imp/commit/64091f2b3aae740906432f410fec5955d8051c22))
- **cli:** imp policy, and imp new --policy and --allow
  ([#26](https://github.com/zgeoff/imp/issues/26))
  ([e04568a](https://github.com/zgeoff/imp/commit/e04568a396a538f4bc62d05bbaa0d9f67f1cc6fc))
- **cli:** imp proxy --reverse relays imp clients to this machine
  ([#64](https://github.com/zgeoff/imp/issues/64))
  ([294ed57](https://github.com/zgeoff/imp/commit/294ed5702b06fa68aea6bd921051e5769a14a0b8))
- **cli:** imp proxy forwards local ports into an imp
  ([8e98e4c](https://github.com/zgeoff/imp/commit/8e98e4c560d12bc6a9487dbc5a4fcc4fbd7d58c4)), closes
  [#25](https://github.com/zgeoff/imp/issues/25)
- **cli:** imp proxy forwards local ports into an imp
  ([#25](https://github.com/zgeoff/imp/issues/25))
  ([2f020f9](https://github.com/zgeoff/imp/commit/2f020f9df167f2ed7db6a940296297e61c33da67))
- **cli:** imp set, imp top, and cpu flags on imp new
  ([#37](https://github.com/zgeoff/imp/issues/37))
  ([326196e](https://github.com/zgeoff/imp/commit/326196ec81a63a6b4f07ec986636fbc99f7d91aa))
- **cli:** imp token key add, ls and rm, and new --ssh-key
  ([#63](https://github.com/zgeoff/imp/issues/63))
  ([598da72](https://github.com/zgeoff/imp/commit/598da7273bc57d7932b96131d10b9e0d8fa5da92))
- **cli:** imp token new, ls, rm and whoami ([#29](https://github.com/zgeoff/imp/issues/29))
  ([d257301](https://github.com/zgeoff/imp/commit/d2573013d18e63c56698dc991ec433de4933f5f0))
- **cli:** note an imp whose agent stopped answering
  ([3fce9ab](https://github.com/zgeoff/imp/commit/3fce9ab6461685c8a975a9f8eb50037c53a5eb7d)), closes
  [#39](https://github.com/zgeoff/imp/issues/39)
- **cli:** note cold boots and outdated parts in imp ls
  ([9451def](https://github.com/zgeoff/imp/commit/9451def6556319e3b5107ffb1fbbe6eeeeae1b80))
- **cli:** note imps an older impd booted
  ([456a498](https://github.com/zgeoff/imp/commit/456a498d593ddbee8bc7725873868ed9870ce164))
- **cli:** pack and upload the build context for imp image build
  ([329b9d2](https://github.com/zgeoff/imp/commit/329b9d2be573f4fcab57e309fdcf3bb8ae73eed5))
- **cli:** print shell completions with imp completion
  ([dce4ba9](https://github.com/zgeoff/imp/commit/dce4ba990d0aba21feb7792c5f0b00c0d7cfe3e9))
- **cli:** save impd hosts with imp login and pick one with --host
  ([2248a81](https://github.com/zgeoff/imp/commit/2248a81ac3a97a46dcc3ac15e88f30d996105050))
- **cli:** send the build context's exact size as its content-length
  ([6125114](https://github.com/zgeoff/imp/commit/6125114e7ccedab586701bc6c133b522426e9f98))
- **cli:** serve imps as mcp tools over stdio with imp mcp
  ([f065796](https://github.com/zgeoff/imp/commit/f0657965743df19343d00f7c479ee6838cbfd94d))
- **cli:** show boot status in imp info and after an upgrade
  ([1fb9131](https://github.com/zgeoff/imp/commit/1fb9131ae0a67f34cd770d0cfadbe64c0cb47781))
- credential connectors through a host-side broker
  ([331b007](https://github.com/zgeoff/imp/commit/331b007aaf8845bd4f3e8e7aed1c2d7043cbd962)), closes
  [#15](https://github.com/zgeoff/imp/issues/15)
- **daemon:** /tunnel websocket to a port in an imp ([#25](https://github.com/zgeoff/imp/issues/25))
  ([cbaa687](https://github.com/zgeoff/imp/commit/cbaa6870ad6429b2f5f165bd4349d8e825807651))
- **daemon:** a cpu limit and weight per imp in a cgroup
  ([#37](https://github.com/zgeoff/imp/issues/37))
  ([aa30993](https://github.com/zgeoff/imp/commit/aa309934a8fa1c5c46add0c6d918a6af5c1deb58))
- **daemon:** add a zfs storage backend
  ([1d394b9](https://github.com/zgeoff/imp/commit/1d394b96b811890bca969e3795ae70cfa4ee4899))
- **daemon:** add backup config and a restic wrapper
  ([51bb10c](https://github.com/zgeoff/imp/commit/51bb10ce76426e3ec2b12dcb43bc12b3d13f0fc5))
- **daemon:** add the https settings and the dns providers
  ([c920a3a](https://github.com/zgeoff/imp/commit/c920a3ac74997861a2f12cea3c8c98cfc67806fb))
- **daemon:** adopt or kill the vms a dead impd left at reconcile
  ([f6fbdb7](https://github.com/zgeoff/imp/commit/f6fbdb7e56e07ca7e3fe3828e9353fcd6b47e528))
- **daemon:** an imp.disk.used gauge from the disk usage cache
  ([a354387](https://github.com/zgeoff/imp/commit/a354387001aa279e9e09d67a2d21cbeb7b9a3fde)), closes
  [#37](https://github.com/zgeoff/imp/issues/37)
- **daemon:** audit each imp proxy tunnel as it opens
  ([2c4fd6f](https://github.com/zgeoff/imp/commit/2c4fd6ffb3ab59afc6f1bf495d68e505a931226e))
- **daemon:** authenticate /exec with single-use tickets
  ([6ac6fd4](https://github.com/zgeoff/imp/commit/6ac6fd437fb3495227a090be9d65ce2d4cf4cb85))
- **daemon:** back up imps with restic and restore them
  ([3721255](https://github.com/zgeoff/imp/commit/3721255ea930a2d676a065a9c2ac15ca70dd1d97))
- **daemon:** broker credentials for imps through a host-side proxy
  ([0feea06](https://github.com/zgeoff/imp/commit/0feea06cdc14aa776c93aa7d371a6d637b921fb0))
- **daemon:** build images from a context streamed by the client
  ([62773d9](https://github.com/zgeoff/imp/commit/62773d90c509010d38d16d380a7f5643edbd3c55))
- **daemon:** choose the storage backend by config
  ([92b1bc5](https://github.com/zgeoff/imp/commit/92b1bc5cfd501b61cb96349c46d8c2430ef98d08))
- **daemon:** count cold boots and outdated imps in system.info
  ([b0515fc](https://github.com/zgeoff/imp/commit/b0515fc47173ceaf126ecfd1651c2457d4047a28))
- **daemon:** egress rules, nft ruleset and dns resolver
  ([#26](https://github.com/zgeoff/imp/issues/26))
  ([ef63318](https://github.com/zgeoff/imp/commit/ef6331863b46bedb2a4a620bcaa4da55f004ce66))
- **daemon:** enforce an egress policy per imp ([#26](https://github.com/zgeoff/imp/issues/26))
  ([ddaf871](https://github.com/zgeoff/imp/commit/ddaf871d8e4d4d5ee2934c7604073f4c9389caf1))
- **daemon:** enforce token scopes and imp patterns on every route
  ([#29](https://github.com/zgeoff/imp/issues/29))
  ([b418db6](https://github.com/zgeoff/imp/commit/b418db6169e716c5ed84cb34a93712aa0dc9c13a))
- **daemon:** export opentelemetry metrics and spans when asked
  ([#38](https://github.com/zgeoff/imp/issues/38))
  ([a0699ac](https://github.com/zgeoff/imp/commit/a0699acadf1ce185f06940a5748b6229b14aed2f))
- **daemon:** forward the ssh-agent into an imp ([#53](https://github.com/zgeoff/imp/issues/53))
  ([6a8618e](https://github.com/zgeoff/imp/commit/6a8618ea5710b0c64c27be5f933a3c2c67b0a601))
- **daemon:** hold disk room before a sleep waits or pauses
  ([6372f6e](https://github.com/zgeoff/imp/commit/6372f6eebe255b0eff2ee7ad6f830b9eed471f3d)), closes
  [#39](https://github.com/zgeoff/imp/issues/39)
- **daemon:** issue a wildcard certificate with acme dns-01
  ([5aa3396](https://github.com/zgeoff/imp/commit/5aa33966178f156b130220ec3fe138d9887bbb70))
- **daemon:** let wake refuse an imp in error, and tighten exec grants
  ([ee6e8f9](https://github.com/zgeoff/imp/commit/ee6e8f9ab97ec7a29c6fdc9c4c8f46f4b5d91de9))
- **daemon:** list, kill and attach detachable sessions
  ([b501d2d](https://github.com/zgeoff/imp/commit/b501d2d672fafb15d916b8d06b79a4924566a269))
- **daemon:** restore grants by name and fetch one file at a time
  ([e4dde1a](https://github.com/zgeoff/imp/commit/e4dde1a3e2e793c1853acfcd60984e47e0725272))
- **daemon:** restore snapshots across an upgrade and say why not
  ([4accb37](https://github.com/zgeoff/imp/commit/4accb3700adee6e9754ae7549b5abe2c2f31cbdb))
- **daemon:** reverse forwards over /tunnel, one relay per accept
  ([#64](https://github.com/zgeoff/imp/issues/64))
  ([9f5036b](https://github.com/zgeoff/imp/commit/9f5036bb0c9d35f8d6ad2a05671e9c20ccd5edb4))
- **daemon:** sample each running imp's cpu, network and memory
  ([#37](https://github.com/zgeoff/imp/issues/37))
  ([9f80607](https://github.com/zgeoff/imp/commit/9f806077ee2cc15bc25d5a13eee0e367c9e7be46))
- **daemon:** serve imps at https://&lt;name&gt;.&lt;domain&gt; on the tailnet
  ([c3478cc](https://github.com/zgeoff/imp/commit/c3478cc0e552d32aafc293ccf633481a5363ce9f))
- **daemon:** serve mcp over http at /mcp
  ([63a7ec1](https://github.com/zgeoff/imp/commit/63a7ec1c67db2c91f439c13b032a45b4c539f2dd)), closes
  [#50](https://github.com/zgeoff/imp/issues/50)
- **daemon:** serve the dashboard and sign it in with a session cookie
  ([c869535](https://github.com/zgeoff/imp/commit/c869535185ea99001f8f4d2a67cf98a387858bcd))
- **daemon:** services api client, serve wrapper and host id
  ([#30](https://github.com/zgeoff/imp/issues/30))
  ([8e80c38](https://github.com/zgeoff/imp/commit/8e80c38a45111860c1f5b0727525b0a0aa96eb2c))
- **daemon:** ssh gateway
  ([70c4be2](https://github.com/zgeoff/imp/commit/70c4be274ca6c52cd5864e99e46d3736ee76d934))
- **daemon:** ssh logins with a bound key run as its token
  ([#63](https://github.com/zgeoff/imp/issues/63))
  ([9f45e07](https://github.com/zgeoff/imp/commit/9f45e07956fffaaf4f1d8d72fb3c6d3a03c699d6))
- **daemon:** store named tokens hashed, beside the root token
  ([#29](https://github.com/zgeoff/imp/issues/29))
  ([9f19610](https://github.com/zgeoff/imp/commit/9f196103ec910a79282c6c0af9a064b979a68a38))
- **daemon:** store ssh keys bound to tokens ([#63](https://github.com/zgeoff/imp/issues/63))
  ([124f67d](https://github.com/zgeoff/imp/commit/124f67dcf634e79ed7952cee19366471a5c3d56c))
- **daemon:** stream imp lifecycle events and audit api calls
  ([#38](https://github.com/zgeoff/imp/issues/38))
  ([1f84fbc](https://github.com/zgeoff/imp/commit/1f84fbcc39402e0bab78039fbfbf6872fc5a4ed6))
- **daemon:** tar tool execs as root, with stdin acks
  ([#24](https://github.com/zgeoff/imp/issues/24))
  ([8387c12](https://github.com/zgeoff/imp/commit/8387c12cd0d0f2283aa5f36d126c8fab4d48a3dc))
- **daemon:** use a host-only secure session cookie over https
  ([a0c9558](https://github.com/zgeoff/imp/commit/a0c9558ee6a730e8f985de786ddd89ee7a179ea5))
- **daemon:** watch for agents that stop answering
  ([3a97467](https://github.com/zgeoff/imp/commit/3a974678f9237690441f9b5e229878767289602a)), closes
  [#39](https://github.com/zgeoff/imp/issues/39)
- **dashboard:** add the web dashboard on tanstack router and the sdk
  ([5ec738f](https://github.com/zgeoff/imp/commit/5ec738fe5cad54d691b4d2ec763648b0131778e0))
- **dashboard:** cpu column and a cpu panel with limit form
  ([#37](https://github.com/zgeoff/imp/issues/37))
  ([6e6df94](https://github.com/zgeoff/imp/commit/6e6df94ef59d4569688f21e14a89dfe4deacee9d))
- **dashboard:** follow impd's event stream in place of a 2 s poll
  ([#38](https://github.com/zgeoff/imp/issues/38))
  ([bd35934](https://github.com/zgeoff/imp/commit/bd3593448eccb67ea933a137fbcfcfc86f06d013))
- **dashboard:** list the ssh keys bound to each token
  ([#63](https://github.com/zgeoff/imp/issues/63))
  ([f969f0a](https://github.com/zgeoff/imp/commit/f969f0aba80afce60cc2855baa6def8a3b5590c2))
- **dashboard:** manage tokens and show who is logged in
  ([#29](https://github.com/zgeoff/imp/issues/29))
  ([931ce30](https://github.com/zgeoff/imp/commit/931ce30922e4ad7c6936a29e716f3c974f445e64))
- **dashboard:** show an imp's https url first
  ([b6324d6](https://github.com/zgeoff/imp/commit/b6324d659a5185838c80362a4f4eacd299807dbf))
- **deploy:** add upgrade.sh that sleeps imps before the restart
  ([9f541f8](https://github.com/zgeoff/imp/commit/9f541f86df24a477e096d24c2a1bae319adee719))
- **deploy:** bootstrap a zfs pool with --storage zfs
  ([e9a5eb9](https://github.com/zgeoff/imp/commit/e9a5eb9baa9c6930b21f16e4ed6e168099891f49))
- **deploy:** bootstrap ubuntu 26.04
  ([3921332](https://github.com/zgeoff/imp/commit/3921332939adcd04bd16b377e627fd16d604c580))
- **deploy:** check the live storage backend in the health phase
  ([39288e8](https://github.com/zgeoff/imp/commit/39288e8f9eed9bc73033e80953b209d11a210a85))
- **deploy:** one-command server bootstrap
  ([7f87178](https://github.com/zgeoff/imp/commit/7f87178b7c491dc901eae830c0a562b8ea8fd957)), closes
  [#9](https://github.com/zgeoff/imp/issues/9)
- **deploy:** one-command server bootstrap
  ([8f6ae3d](https://github.com/zgeoff/imp/commit/8f6ae3d9347551c30f4179d66f9d2ba055f93aa3))
- **deploy:** size a loop file from the free space on /
  ([ec536a2](https://github.com/zgeoff/imp/commit/ec536a2c8cae271013730b23d98caa6b1a113d92))
- detachable sessions
  ([fe475eb](https://github.com/zgeoff/imp/commit/fe475ebc30ec5914e9f707de8a21823715d09526)), closes
  [#13](https://github.com/zgeoff/imp/issues/13)
- **dev:** read the tailscale key from 1password before .env
  ([ca9e093](https://github.com/zgeoff/imp/commit/ca9e093059d75a62b8081d408f19958684d6c18a))
- **dev:** read the tailscale key from 1password, with .env as fallback
  ([1ded041](https://github.com/zgeoff/imp/commit/1ded041ac9d2e4baab17c579add161deff20bc64))
- **dev:** write the tailnet names oauth file from 1password
  ([#30](https://github.com/zgeoff/imp/issues/30))
  ([61c92ae](https://github.com/zgeoff/imp/commit/61c92aeaf4e73048150f6f365c7d1d4e9e2a9ed0))
- disk budget and per-imp disk use
  ([52658ee](https://github.com/zgeoff/imp/commit/52658ee7a5e2581782f0c1340f263ca939534c0e)), closes
  [#21](https://github.com/zgeoff/imp/issues/21)
- disk sizes on create, and a resize that only grows
  ([dd4c7bd](https://github.com/zgeoff/imp/commit/dd4c7bd74c23e35bbf54df1358f2d334e0f79fb0))
- disk use in imp top and the dashboard ([#37](https://github.com/zgeoff/imp/issues/37))
  ([fb5e019](https://github.com/zgeoff/imp/commit/fb5e0192be7c1a132363bad09af479198725487e))
- **egress:** ipv6 in every slot chain, box allow6 sets and nat66
  ([#32](https://github.com/zgeoff/imp/issues/32))
  ([871e77d](https://github.com/zgeoff/imp/commit/871e77db34f3d999036f5cf036123f07e31aeed8))
- forward the user's ssh-agent into an imp
  ([0b299d2](https://github.com/zgeoff/imp/commit/0b299d2ace27554aef1676f8c1a2e9a0e94c546c)), closes
  [#53](https://github.com/zgeoff/imp/issues/53)
- **host:** give imps a cgroup tree in a private cgroup namespace
  ([#37](https://github.com/zgeoff/imp/issues/37))
  ([1f96894](https://github.com/zgeoff/imp/commit/1f96894f111dad537a31820858ea61c7aff3c09e))
- **host:** ipv6 on the taps: ndp only, no ra, nothing unasked in
  ([#32](https://github.com/zgeoff/imp/issues/32))
  ([9a34d96](https://github.com/zgeoff/imp/commit/9a34d96f514d7c1a74312ed3427c55ec7008ed1f))
- **host:** mount a zfs dataset as the data dir
  ([ec9de15](https://github.com/zgeoff/imp/commit/ec9de15547d06b632f92ef0cd3f49721552946eb))
- **host:** nftables, conntrack and the egress resolver port
  ([#26](https://github.com/zgeoff/imp/issues/26))
  ([79a3103](https://github.com/zgeoff/imp/commit/79a3103b05081f177ffbd60150bade4846f62c3a))
- **host:** open the broker port to guests and filter spoofed sources
  ([4dcfbcf](https://github.com/zgeoff/imp/commit/4dcfbcfc0f82f65081a4505ab64a09813ca68ea3))
- https urls on your own domain
  ([780e522](https://github.com/zgeoff/imp/commit/780e5223184a2afa825d0629d3f536dbb7e6b503)), closes
  [#16](https://github.com/zgeoff/imp/issues/16)
- **https:** serve chosen imps to the internet
  ([8268eda](https://github.com/zgeoff/imp/commit/8268edae4ab8153c29ef27ea8cfcab087e3038ae)), closes
  [#52](https://github.com/zgeoff/imp/issues/52)
- **images:** size an image's ext4 to its tree
  ([7df8bce](https://github.com/zgeoff/imp/commit/7df8bceedb42612ad4e230567945a7b562b1ca25))
- **images:** upload a build context from the client
  ([38c8c71](https://github.com/zgeoff/imp/commit/38c8c715fb3afc04b2ec0d7ac5eb2a1793ab3efa))
- imp cp copies files in and out of an imp
  ([5feb3ce](https://github.com/zgeoff/imp/commit/5feb3ce51f20b187824428687c082406508eee8b)), closes
  [#24](https://github.com/zgeoff/imp/issues/24)
- **imps:** a new ipv6 prefix boots cold; imp info says no ipv6
  ([#32](https://github.com/zgeoff/imp/issues/32))
  ([3cdf5a6](https://github.com/zgeoff/imp/commit/3cdf5a60466a70ac8b509e30379b9922782db0d1))
- **mcp:** add a streamable http transport and a pattern guard
  ([6bd91fa](https://github.com/zgeoff/imp/commit/6bd91fa8ea1b7968abba0c5d7b087411d94681a6))
- **mcp:** add an mcp server package with imp tools
  ([74507d1](https://github.com/zgeoff/imp/commit/74507d1ef64a2334fc5aaa624322b8f8c6182624))
- **mcp:** let the agent kill a stopped command's process group
  ([753448a](https://github.com/zgeoff/imp/commit/753448ac438ec0a4f561f2faf869bf84d3fb90ec))
- **mcp:** serve imps as mcp tools with imp mcp
  ([15eca71](https://github.com/zgeoff/imp/commit/15eca7115eb4443e8556584ce8766bb78f6a3eb2)), closes
  [#20](https://github.com/zgeoff/imp/issues/20)
- **mcp:** serve mcp over http from impd with scoped tokens
  ([1235313](https://github.com/zgeoff/imp/commit/1235313917b85302bf3af0770f8f23e0a0b0c258)), closes
  [#50](https://github.com/zgeoff/imp/issues/50)
- **net:** an ipv6 /64 per host, a /128 per imp on its tap
  ([#32](https://github.com/zgeoff/imp/issues/32))
  ([35c506a](https://github.com/zgeoff/imp/commit/35c506ae20994706fb0acef0a54f7fb0cba54f55))
- **net:** per-imp tailnet names through tailscale services
  ([5713e38](https://github.com/zgeoff/imp/commit/5713e3800d3f0f89b58a9235234b4c95f3a47bf1)), closes
  [#30](https://github.com/zgeoff/imp/issues/30)
- off-host backups with restic
  ([30673d6](https://github.com/zgeoff/imp/commit/30673d6fd20b28f47805f67b2669ed5b2f24d157)), closes
  [#12](https://github.com/zgeoff/imp/issues/12)
- per-imp tailnet names as tailscale services, opt-in
  ([#30](https://github.com/zgeoff/imp/issues/30))
  ([540589e](https://github.com/zgeoff/imp/commit/540589e3f833e9531949997e9e05de1537818d38))
- **release:** install the cli with a checked install script
  ([5c35cc8](https://github.com/zgeoff/imp/commit/5c35cc81bdbdc7655990ffb0f53bb7d5143885a4))
- **release:** update the homebrew formula in the tap
  ([9f14870](https://github.com/zgeoff/imp/commit/9f1487071c3c91cbca249b5e30c1d63c96a59312))
- reverse forwards from an imp back to the client
  ([da77e24](https://github.com/zgeoff/imp/commit/da77e242cb9d999ddb68b515af84df876d4e33dc)), closes
  [#64](https://github.com/zgeoff/imp/issues/64)
- scoped tokens and tailnet identity
  ([972ff74](https://github.com/zgeoff/imp/commit/972ff742873b52b21b4a6ed41115535460552d2a)), closes
  [#29](https://github.com/zgeoff/imp/issues/29)
- **scripts:** add a kvm probe that fails fast without /dev/kvm
  ([d8493bf](https://github.com/zgeoff/imp/commit/d8493bf761b822a1bd7d21b8735c789459bf25b7))
- **scripts:** let dev.sh use a host image built elsewhere
  ([9dfb983](https://github.com/zgeoff/imp/commit/9dfb9830fcec9046f8947316fa956b23deaadf90))
- **security:** egress policy per imp
  ([e4ab5ab](https://github.com/zgeoff/imp/commit/e4ab5ab493708681e1a9945c6acffd82bf3e1435)), closes
  [#26](https://github.com/zgeoff/imp/issues/26)
- service add --http-port, and recorded in services.list
  ([15e9635](https://github.com/zgeoff/imp/commit/15e96350c47fa25ca3a47c0f4d4568037f782071)), closes
  [#23](https://github.com/zgeoff/imp/issues/23)
- services api, imp service and imp logs, protocol 0.10.0
  ([#23](https://github.com/zgeoff/imp/issues/23))
  ([d5b5b11](https://github.com/zgeoff/imp/commit/d5b5b1132f23fd2ffce9fdb361ecc8a4c109c93b))
- show boot status after an upgrade in imp info
  ([54ab78f](https://github.com/zgeoff/imp/commit/54ab78f07b7bfa9ae46d2e2e4ac560ec664a94b2)), closes
  [#49](https://github.com/zgeoff/imp/issues/49)
- ssh into an imp through impd's ssh gateway
  ([37335cd](https://github.com/zgeoff/imp/commit/37335cdef483d18971ebccb3eb8bc8154a63bd45)), closes
  [#14](https://github.com/zgeoff/imp/issues/14)
- **ssh:** bind ssh keys to scoped tokens
  ([0436331](https://github.com/zgeoff/imp/commit/0436331cddbdee70ebdab95a7be21be3afc24b1c)), closes
  [#63](https://github.com/zgeoff/imp/issues/63)
- **ssh:** remote forwards listen in the guest, on loopback
  ([#64](https://github.com/zgeoff/imp/issues/64))
  ([9941228](https://github.com/zgeoff/imp/commit/99412282cd7dd904c7427957c89fa582c6aa7d91))
- **storage:** a disk budget with a reserve no write may take
  ([acc3d61](https://github.com/zgeoff/imp/commit/acc3d61429e97c0809e33acc6de22fab91006d88))
- **storage:** a gc behind a storage gate
  ([a2de654](https://github.com/zgeoff/imp/commit/a2de6546d30fbc833689a42337a246e96c642ce3))
- **storage:** add backup copies and backup trees for xfs and zfs
  ([0109e41](https://github.com/zgeoff/imp/commit/0109e41e0c2984a0871128e4d01a04499dfcfcba))
- **storage:** grow a stopped disk's filesystem on the host
  ([5fd883c](https://github.com/zgeoff/imp/commit/5fd883c078b170733731256b40c46de5a39253fd))
- **storage:** measure each imp's exclusive and shared disk usage
  ([4b8f49e](https://github.com/zgeoff/imp/commit/4b8f49e89b13fad31d20feb073bc63cddad085b8))
- **storage:** one disk ledger, and a usage pass that resumes
  ([0f2cbc0](https://github.com/zgeoff/imp/commit/0f2cbc00bf88b897738b9d5226ceaa99667f842e))
- stream imp events, audit api calls and export metrics
  ([1072ade](https://github.com/zgeoff/imp/commit/1072adec1cea5914b21cc216193ffa712b5df175)), closes
  [#38](https://github.com/zgeoff/imp/issues/38)
- templates, images made from an imp's disk
  ([8faee61](https://github.com/zgeoff/imp/commit/8faee61085b528cb3a94cbbb0199840fde522362)), closes
  [#22](https://github.com/zgeoff/imp/issues/22)
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

- **agent:** a copy into the imp keeps the holes of a file
  ([#24](https://github.com/zgeoff/imp/issues/24))
  ([ee87cce](https://github.com/zgeoff/imp/commit/ee87ccebd9f8f52d36130c611feb74920e501d8d))
- **agent:** a copy takes the owner of the directory it lands in
  ([#24](https://github.com/zgeoff/imp/issues/24))
  ([3b38ea4](https://github.com/zgeoff/imp/commit/3b38ea4c9f226818c4b7c2feaa0504ef881a6e9b))
- **agent:** dial unix sockets as the image user, protocol 0.6.0
  ([#60](https://github.com/zgeoff/imp/issues/60))
  ([dcccdee](https://github.com/zgeoff/imp/commit/dcccdeeb931c50fba3f1e5fcee28e9b8a4080c33))
- **agent:** gofmt the session viewer, and gate pushes on the go job
  ([94ab9be](https://github.com/zgeoff/imp/commit/94ab9beb4504f0efc51ca4d77255e69a5c1a1742)), closes
  [#13](https://github.com/zgeoff/imp/issues/13)
- **agent:** keep an unsent exit and bound viewers that stop reading
  ([968c664](https://github.com/zgeoff/imp/commit/968c66468fd083c21298dd45e38a8c69e46eacc0))
- **agent:** kill the dial helper by pidfd, its stdio on /dev/null
  ([#60](https://github.com/zgeoff/imp/issues/60))
  ([029e3d0](https://github.com/zgeoff/imp/commit/029e3d0c6a09ece8222e7ee6f895932ff34faa17))
- **agent:** kill the process group when cgroup.kill fails
  ([fcabcff](https://github.com/zgeoff/imp/commit/fcabcff2b12d45a2b85d8ff96e8ea0028891abbb)), closes
  [#69](https://github.com/zgeoff/imp/issues/69)
- **agent:** leave uptime out of ping when the clock read fails
  ([47fcb71](https://github.com/zgeoff/imp/commit/47fcb71a8d13f4ba1eee7310d1333bea0b51e568)), closes
  [#33](https://github.com/zgeoff/imp/issues/33)
- **agent:** reset the dial test's target only after the half-close
  ([60e147e](https://github.com/zgeoff/imp/commit/60e147e534704f1257fe8ccd3d38c65675809b78))
- an atomic fake size file, and wait for the e2e usage pass
  ([d86bd6b](https://github.com/zgeoff/imp/commit/d86bd6b19f231bac98008cfb311c9bb7f4ff5419))
- **api:** type exec frames so a browser websocket accepts them
  ([3ee5429](https://github.com/zgeoff/imp/commit/3ee54296d20be015297c4d61fb8b5dcb10ddc961))
- **backup:** a restored image joins the storage gate until its row
  ([079dc9f](https://github.com/zgeoff/imp/commit/079dc9f217869f80456342dce00bbaf8e98f0204))
- **backup:** cap prune lock retries and name the lock holder
  ([c71bebc](https://github.com/zgeoff/imp/commit/c71bebc759758061c309ee24b79ca1c644b8df39))
- **backup:** check found data against allocated bytes, not errno
  ([a1946f0](https://github.com/zgeoff/imp/commit/a1946f0840992588ff459a1f3aa91cbae8cb60a8))
- **backup:** wait for restic locks and list snapshots without one
  ([6c02a4e](https://github.com/zgeoff/imp/commit/6c02a4e9c2cdcb3f846ce7c15e9c4a1539b49bc0))
- **backup:** wait for restic locks and list snapshots without one
  ([3cb33f2](https://github.com/zgeoff/imp/commit/3cb33f272acedb0330d0ff7058fc3c7ec919d787))
- **broker:** keep plain-tunnel tests off the network
  ([58c9a6f](https://github.com/zgeoff/imp/commit/58c9a6f2d8c8030d1405817ea96ef53b55f955f4))
- **build:** keep ssh2's optional cpu-features out of the impd binary
  ([5c654d3](https://github.com/zgeoff/imp/commit/5c654d3c1ab08e3b3babb8acd040161d6b8f4c14))
- **cli:** end exec sessions cleanly on every failure and signal
  ([7ed046e](https://github.com/zgeoff/imp/commit/7ed046eb92e295ecf217400f2b3cdba022a46697))
- **client:** bound unread exec output and stop on cancel
  ([eb87eb0](https://github.com/zgeoff/imp/commit/eb87eb014e07fc6b117860e19dd57c747b301df3))
- **client:** make the awake helper one wake call that rides out restarts
  ([9bdb563](https://github.com/zgeoff/imp/commit/9bdb56380221148dfa95985b4eaa5073052b147c))
- **client:** open the login shell of the image's user, not root's
  ([d5c366c](https://github.com/zgeoff/imp/commit/d5c366cb1fd2f3229bc20c0fb06970ede4a50138))
- **client:** reject an abort during the connect with its reason
  ([5ea0f54](https://github.com/zgeoff/imp/commit/5ea0f54e9dbe4cecd33fcaf3d287a504b3eed4b9))
- **client:** treat a socket error before open as a refused upgrade
  ([17b7eb1](https://github.com/zgeoff/imp/commit/17b7eb12c385f73d9223740a38dd4f80ebf9ed16))
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
- **cli:** pack the context as buildx sends it with any ignore file
  ([98a698b](https://github.com/zgeoff/imp/commit/98a698b7d132be16df86c96e8a8702b5eba2099b))
- **cli:** print the validation issues of a bad request
  ([1cb54ce](https://github.com/zgeoff/imp/commit/1cb54ce755c0ad738014effb0728ae6135e77504))
- **cli:** proxy close codes, bad json, port hints and retries
  ([#25](https://github.com/zgeoff/imp/issues/25))
  ([5859d87](https://github.com/zgeoff/imp/commit/5859d87c08b228221c04f9cace689bec741d8f1c))
- **cli:** reverse forwards retry impd restarts, end with the imp
  ([#64](https://github.com/zgeoff/imp/issues/64))
  ([97068f5](https://github.com/zgeoff/imp/commit/97068f54ab6486f210822aec750ccf16202280cc))
- **cli:** safer reattach, detach key forms and mode reset
  ([5775105](https://github.com/zgeoff/imp/commit/5775105d95eed5f5b102ae72383b4a801a8c8bf8))
- **cli:** show boot status as unknown for an older impd
  ([1d3665d](https://github.com/zgeoff/imp/commit/1d3665dd729f60cafdd5d6d032bf1ea2f53c4f10))
- **cli:** validate arguments and make command output consistent
  ([bea70f4](https://github.com/zgeoff/imp/commit/bea70f45850bc5514eaf4eaedf12ede4d1e9c5c7))
- **daemon:** a reverse forward's listener holds a tunnel slot
  ([#64](https://github.com/zgeoff/imp/issues/64))
  ([166ec47](https://github.com/zgeoff/imp/commit/166ec47867a4f7398fef8e629e3e6709bf752235))
- **daemon:** a tool exec needs manage scope, and no ticket
  ([#24](https://github.com/zgeoff/imp/issues/24))
  ([07c26b1](https://github.com/zgeoff/imp/commit/07c26b12af59d6484786435128c7eb62ca8466c2))
- **daemon:** allow a zfs minor version skew with a warning
  ([cf8362a](https://github.com/zgeoff/imp/commit/cf8362a3dd604628cdc874afefbf0033fedab751))
- **daemon:** bound resolver tcp, reply ttls and upstream ids
  ([#26](https://github.com/zgeoff/imp/issues/26))
  ([404ce47](https://github.com/zgeoff/imp/commit/404ce4725c86630de562f60b74e536a0845a4f37))
- **daemon:** bound the young-guest wait and skip it for the governor
  ([c655703](https://github.com/zgeoff/imp/commit/c65570307e3c78f181e0a08b008e5f18dcd171d2)), closes
  [#33](https://github.com/zgeoff/imp/issues/33)
- **daemon:** build the guest's ca bundle there and retry on failure
  ([38c1c1a](https://github.com/zgeoff/imp/commit/38c1c1a6f5d1c8bb66ae209f1db3f4849c60fedb))
- **daemon:** cap long timers at the runtime's limit
  ([abbc951](https://github.com/zgeoff/imp/commit/abbc951dd44f77bd8f7b2f7139d6f1008ffa21e9))
- **daemon:** cap the event stream's end timer at setTimeout's limit
  ([830b437](https://github.com/zgeoff/imp/commit/830b437606e659eedc91368fad7dd741a9a0d882))
- **daemon:** check broker tunnels against the latest policy
  ([#26](https://github.com/zgeoff/imp/issues/26))
  ([7f67783](https://github.com/zgeoff/imp/commit/7f67783c09811e66f7c9ee6a36369aeba62a3409))
- **daemon:** check the dns api url, the ca file and the test provider
  ([3fa10b8](https://github.com/zgeoff/imp/commit/3fa10b84ecc756ac69e95db094e9a85b0becd7c4))
- **daemon:** clear a gone imp's service without a drain first
  ([#30](https://github.com/zgeoff/imp/issues/30))
  ([ad577bb](https://github.com/zgeoff/imp/commit/ad577bb9f477da61a5fe35115b38ed332aad12d7))
- **daemon:** close a socket revoked before it opens
  ([#29](https://github.com/zgeoff/imp/issues/29))
  ([68fde3b](https://github.com/zgeoff/imp/commit/68fde3b832333075a5a393c53496725a958548d2))
- **daemon:** close a tunnel that passes its window ([#25](https://github.com/zgeoff/imp/issues/25))
  ([990949d](https://github.com/zgeoff/imp/commit/990949dcbf195787d4f71fbb789a84c6ed644a56))
- **daemon:** confirm enxio, check restored egress, reset backoff
  ([6766181](https://github.com/zgeoff/imp/commit/6766181e7969f0aea96a420c02c854dcff19aebc))
- **daemon:** count the tunnel cap by imp id, not name
  ([#25](https://github.com/zgeoff/imp/issues/25))
  ([74cefa2](https://github.com/zgeoff/imp/commit/74cefa2c6a8d9240f1e9dd78ea5d3cc9f9db89cc))
- **daemon:** drop stale restic locks before each backup run
  ([a226d9e](https://github.com/zgeoff/imp/commit/a226d9e5891e6c7a847bd044af28d6c804d28c15))
- **daemon:** enforce sleeps every eligible imp when short of budget
  ([aa2ff6a](https://github.com/zgeoff/imp/commit/aa2ff6a086579fb8f0af4a62a0754e27d4a5bfed)), closes
  [#46](https://github.com/zgeoff/imp/issues/46)
- **daemon:** enforce sleeps every eligible imp when short of budget
  ([f69efb8](https://github.com/zgeoff/imp/commit/f69efb82e284e4b469fd57236a432853b0f1c34c)), closes
  [#46](https://github.com/zgeoff/imp/issues/46)
- **daemon:** find an existing acme account before making one
  ([8d1959b](https://github.com/zgeoff/imp/commit/8d1959bee5c266701ab058fc20a80475de338d77))
- **daemon:** flush a snapshot's files before its record
  ([4146fcb](https://github.com/zgeoff/imp/commit/4146fcbdd14251acc1acd843b59b36552eef248d)), closes
  [#39](https://github.com/zgeoff/imp/issues/39)
- **daemon:** hand peer handles only to /rpc, /exec and /tunnel
  ([#29](https://github.com/zgeoff/imp/issues/29))
  ([88a7bf3](https://github.com/zgeoff/imp/commit/88a7bf37708d25a22918c34fe35662853a283726))
- **daemon:** harden the dashboard session against imps
  ([ba6f01c](https://github.com/zgeoff/imp/commit/ba6f01ca3bf62ef6100df977fdeac15c3d10e2b1))
- **daemon:** judge /mcp origins by the dashboard's same-origin rule
  ([0e7380d](https://github.com/zgeoff/imp/commit/0e7380da50cc436c717c91001573700612f59453))
- **daemon:** keep a woken vm that will not stop off the disk
  ([89d2e0a](https://github.com/zgeoff/imp/commit/89d2e0a76a1e8074883f8a449a876c782f8ba2cf))
- **daemon:** keep frozen guests out of the zfs reclaim queue
  ([1f9ee54](https://github.com/zgeoff/imp/commit/1f9ee54dd5a2aaf83c49c03cbdcf7abf768590ba))
- **daemon:** kill an image build when its client disconnects
  ([1f430af](https://github.com/zgeoff/imp/commit/1f430afb0e4f1418d9c477225a7d32117c01707b))
- **daemon:** make meta.json the commit record of a snapshot
  ([0fe55e1](https://github.com/zgeoff/imp/commit/0fe55e1b4eb9d6804a4adeea9610161a5df4474d))
- **daemon:** never replace a dns record impd did not make
  ([a437046](https://github.com/zgeoff/imp/commit/a437046b9c9b24b4dfbd9ab49e385f92bffa3d46))
- **daemon:** never unbind a key that authorized_keys lists
  ([#63](https://github.com/zgeoff/imp/issues/63))
  ([630ea7c](https://github.com/zgeoff/imp/commit/630ea7c60c12019556b4887bed04608ab03cd09e))
- **daemon:** pass the session to the api on the bare domain
  ([69beef4](https://github.com/zgeoff/imp/commit/69beef4997110090858cdad65fcad0f22f5c8699))
- **daemon:** pick again after each governor sleep
  ([bf8481b](https://github.com/zgeoff/imp/commit/bf8481b7a19b8856a43af20c5b2c957e27af1ded))
- **daemon:** refuse a session on an agent from before sessions
  ([8f4de56](https://github.com/zgeoff/imp/commit/8f4de56e2c17d1bab39dd7772b5d26085471e02f))
- **daemon:** refuse api and proxy ports inside the imp ports
  ([5277669](https://github.com/zgeoff/imp/commit/52776697e733dae780788c3c6324f48472aa52e5))
- **daemon:** refuse egress tcp with a reset so live flows end
  ([#26](https://github.com/zgeoff/imp/issues/26))
  ([db94b54](https://github.com/zgeoff/imp/commit/db94b54c20eed081ee85c75ad5bd108fdfafa64a))
- **daemon:** repair crashed image builds and write the marker late
  ([b609842](https://github.com/zgeoff/imp/commit/b609842e07f5be1929299c74fae8e698fa531bf3))
- **daemon:** report an old agent as outdated for every session op
  ([4fd846b](https://github.com/zgeoff/imp/commit/4fd846bd74c676650fe180615fdcf5b19b59a427))
- **daemon:** restart only the silent vm the watchdog saw
  ([a2b4914](https://github.com/zgeoff/imp/commit/a2b491400d1f406f29d92e15af0d1e602b3e4bd2)), closes
  [#39](https://github.com/zgeoff/imp/issues/39)
- **daemon:** restore every block when lseek cannot tell holes apart
  ([c6b0c53](https://github.com/zgeoff/imp/commit/c6b0c5334f6d0f03bdad276766b40e87b9000f04))
- **daemon:** reuse the acme account by its stored url
  ([53d9895](https://github.com/zgeoff/imp/commit/53d989539ecf3487f57611954fb2045e9b74e30c))
- **daemon:** run a scheduled backup once it is due
  ([e364d5e](https://github.com/zgeoff/imp/commit/e364d5eda47793d92421aa373d4eda7d3fb50cf3))
- **daemon:** serialize slot changes with policy rollbacks
  ([#26](https://github.com/zgeoff/imp/issues/26))
  ([70bd00a](https://github.com/zgeoff/imp/commit/70bd00a17312b67380ce85e4ef6fb77e8395b4f1))
- **daemon:** set a wake's snapshot record aside before the load
  ([c89ee5e](https://github.com/zgeoff/imp/commit/c89ee5eb2564d346419f6c4b769409549ebaea52)), closes
  [#39](https://github.com/zgeoff/imp/issues/39)
- **daemon:** skip the node's own tailnet addresses, know its v6
  ([#29](https://github.com/zgeoff/imp/issues/29))
  ([686275d](https://github.com/zgeoff/imp/commit/686275dfc0b55c0e26584ed9943ea6ac39feba4c))
- **daemon:** spawn firecracker and hash the kernel once at start
  ([db12964](https://github.com/zgeoff/imp/commit/db12964cc2381b5c03527b52df298896ba38c93d))
- **daemon:** stop the upstream request when the client goes away
  ([8a3a677](https://github.com/zgeoff/imp/commit/8a3a67758e78c357995331bb1ab437b82a7fdd94))
- **daemon:** undo a policy change that nft does not take
  ([#26](https://github.com/zgeoff/imp/issues/26))
  ([5ed7bc0](https://github.com/zgeoff/imp/commit/5ed7bc08450228251d8365304187bcf597908520))
- **daemon:** unix socket forwards need agent 0.6.0 ([#60](https://github.com/zgeoff/imp/issues/60))
  ([7afc776](https://github.com/zgeoff/imp/commit/7afc77690ebe8c83c96d3aa55214a032b87f0093))
- **daemon:** wait for a young guest before a sleep
  ([bfac671](https://github.com/zgeoff/imp/commit/bfac671fda13be038df5feb59fa19f64f7dc22c4)), closes
  [#33](https://github.com/zgeoff/imp/issues/33)
- **daemon:** wait for a zfs reclaim at shutdown and in tests
  ([c03e603](https://github.com/zgeoff/imp/commit/c03e603f95d21050103fb67c2a3abf037f92fc61))
- **dashboard:** clear state on logout and follow an ended session
  ([ad18360](https://github.com/zgeoff/imp/commit/ad183604e51202e09829deb45f9dc691b6cb1b03))
- **dashboard:** never redirect from an unmounted console
  ([fe3a999](https://github.com/zgeoff/imp/commit/fe3a999dffbb998886ac9678c419ca37b9995755))
- **db:** number the token ssh keys migration 008
  ([ed3d197](https://github.com/zgeoff/imp/commit/ed3d1971918a0d90843d22f6a65cb39563153dd3))
- **deploy:** drop the blanked key from the running container
  ([47bf6a5](https://github.com/zgeoff/imp/commit/47bf6a550e67b76c10e7ea2fd830f1168311f6b4))
- **deploy:** embed the env template with the https settings
  ([bb9f366](https://github.com/zgeoff/imp/commit/bb9f366adae5e377e99f0ce6c25cac7c8d4e5417))
- **deploy:** let --storage zfs take an env file copied from the template
  ([d8930d4](https://github.com/zgeoff/imp/commit/d8930d4d4d6361563303f6978edff448b21b5119))
- **deploy:** refuse sudo without -e before the firewall phase
  ([229c516](https://github.com/zgeoff/imp/commit/229c516d1cc75e140e73bbb75fd28a1ca8095739))
- **deploy:** refuse zfs when fstab mounts /var/lib/imp
  ([810ba9d](https://github.com/zgeoff/imp/commit/810ba9d6aa6bbee16c0114e8e443e0ceaa96b363))
- **deploy:** review fixes for the server bootstrap
  ([a7216a8](https://github.com/zgeoff/imp/commit/a7216a8181157fb994ca453c99766ea7c5709a93))
- **deploy:** stop upgrade.sh when listing imps fails
  ([7689ac2](https://github.com/zgeoff/imp/commit/7689ac240104936dce0761b00ef5ad6afd178bfd))
- **deploy:** treat built-in modules and a joined node as present
  ([ae506e0](https://github.com/zgeoff/imp/commit/ae506e0ed6a3db171c36641fa4beae1683731bb1))
- **deps:** ignore a node-forge advisory that impd never hits
  ([34fdb45](https://github.com/zgeoff/imp/commit/34fdb45cfd6a8ece49968f80390162fdf535f2d5)), closes
  [#16](https://github.com/zgeoff/imp/issues/16)
- **dev:** keep the tailscale key out of traces and ask op once
  ([bf64471](https://github.com/zgeoff/imp/commit/bf6447198c2eeae4a17569f0521b8bbbd2f7be59))
- **dev:** read the tailscale key from 1password only when a run needs it
  ([7924b0b](https://github.com/zgeoff/imp/commit/7924b0b2ccd17ce8dd9b11a42d9c0fe0ce99de29))
- disk sizes reach the event stream; usage follows the write feed
  ([047e2ac](https://github.com/zgeoff/imp/commit/047e2acd1c89fd938e2333580ac423b11857e62b))
- **e2e:** put the ignore-unknown line before every ssh host block
  ([3df70c0](https://github.com/zgeoff/imp/commit/3df70c0b70752aa79107ae9ccf82340a6f69dbf1))
- **egress:** block ::/96, ::ffff:0:0:0/96 and 100::/64 for imps
  ([#32](https://github.com/zgeoff/imp/issues/32))
  ([f2c6977](https://github.com/zgeoff/imp/commit/f2c69774dc37803798818cfdbcfcec8b96dfda5a))
- **host:** check guest sources per tap; keep the broker to guests
  ([1c051ee](https://github.com/zgeoff/imp/commit/1c051ee14333da3a07e4e1cb69b73085c83c0104))
- **host:** install dev dependencies in the release compile stage
  ([289fcd8](https://github.com/zgeoff/imp/commit/289fcd889ddd204b4f5645ff8ef71861a5f397d8)), closes
  [#7](https://github.com/zgeoff/imp/issues/7)
- **host:** refuse to mount a loop file that is still attached
  ([8050a82](https://github.com/zgeoff/imp/commit/8050a82294eb81dd4b9c7bff14361d5376933e4e)), closes
  [#39](https://github.com/zgeoff/imp/issues/39)
- **https:** keep the acme account key with its url
  ([31706c5](https://github.com/zgeoff/imp/commit/31706c5da442d34d01437e330735b69047f49525))
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
- **net:** ipv6 fails closed; host prefixes match in any spelling
  ([#32](https://github.com/zgeoff/imp/issues/32))
  ([ffdc76b](https://github.com/zgeoff/imp/commit/ffdc76bf8a10f17b53be221c55b2682d03697cda))
- **net:** keep the acme account key and url together
  ([647c2fd](https://github.com/zgeoff/imp/commit/647c2fdc5f68de804e467233e943ccc77299edfc))
- **net:** move the v0.1.1 acme account into account.json
  ([68a2451](https://github.com/zgeoff/imp/commit/68a2451caa0785ad79f6c48f914456753bff2a1b))
- **net:** write ipv6 sysctls only when they differ ([#32](https://github.com/zgeoff/imp/issues/32))
  ([4ffb9bb](https://github.com/zgeoff/imp/commit/4ffb9bbdd7aaad66bc1b8d182982a0d73f6ac4c3))
- pick again after each governor sleep
  ([dc8a01c](https://github.com/zgeoff/imp/commit/dc8a01c0d615b7a73a3dc368b6ca71459fd3465e)), closes
  [#47](https://github.com/zgeoff/imp/issues/47)
- point the public limits comment at its docs, and gate on lint:docs
  ([d8f8eef](https://github.com/zgeoff/imp/commit/d8f8eefbf4239738d450a3a6d2838f96a94963c6))
- **release:** give npm publish a ./ path to the tarball
  ([7cb1378](https://github.com/zgeoff/imp/commit/7cb13785e4de0aa2247456e7e7266266be9649c0))
- **release:** keep the tap token out of git config, fail on bad binaries
  ([88efc46](https://github.com/zgeoff/imp/commit/88efc4604c26451ed4c47a3abb511df8b5e6943c))
- **release:** make the binary executable before brew runs it
  ([a218b8d](https://github.com/zgeoff/imp/commit/a218b8d83c7b540067864f7faa79383a8ad2f6fe))
- **scripts:** destroy zfs test pools by force and keep stuck files
  ([671381c](https://github.com/zgeoff/imp/commit/671381c8d190241806d4ca4916bf1712d6a7156a))
- show an agent error's code once, and rebuild the dev drive on up
  ([65d3256](https://github.com/zgeoff/imp/commit/65d32565a16f025a6d2a3b463fc6358cd4b7fc47))
- **ssh:** one listen per remote forward key, even at once
  ([#64](https://github.com/zgeoff/imp/issues/64))
  ([9b98e48](https://github.com/zgeoff/imp/commit/9b98e481804d6e650cae55ff319b8037cb092e2c))
- **ssh:** refuse forwards to impd's own sockets under /run/imp
  ([#53](https://github.com/zgeoff/imp/issues/53))
  ([8fc99b6](https://github.com/zgeoff/imp/commit/8fc99b6f82ae18fdd7562682589b7877998ae980))
- **storage:** drop a running imp's xfs backup copy when the tree closes
  ([34b6138](https://github.com/zgeoff/imp/commit/34b61387aa7d04525fe1042c104c3c878ada3733))
- **storage:** mount zfs backup clones with -o ro
  ([403f90d](https://github.com/zgeoff/imp/commit/403f90d5f7eac569d2e1749e3d5b0ec2e40cc6cf))
- **test:** take test ports from below the kernel's ephemeral range
  ([c8f004a](https://github.com/zgeoff/imp/commit/c8f004acd7860c647ea52321c99f6571824d8479))
- unix socket forwards dial as the image user
  ([99e01dd](https://github.com/zgeoff/imp/commit/99e01dde5482fa9d8e30aa429a49f35defdc87d7)), closes
  [#60](https://github.com/zgeoff/imp/issues/60)
- wait for a young guest before a sleep, so its wake is fast
  ([9c3bc37](https://github.com/zgeoff/imp/commit/9c3bc370c153883df94175700e4e4925386c17cc)), closes
  [#33](https://github.com/zgeoff/imp/issues/33)
- wakes pass the disk reserve; an old agent's grow is agent_outdated
  ([f2f2836](https://github.com/zgeoff/imp/commit/f2f2836df1deb90e1161061816137e4fd4e829bc))

### Performance Improvements

- **daemon:** skip holes when a restore writes a disk
  ([db245ce](https://github.com/zgeoff/imp/commit/db245ce9c13bd2dce9ebf7870bbe1b56fd62fcc9))

## [0.11.0](https://github.com/zgeoff/imp/compare/v0.10.0...v0.11.0) (2026-10-02)

### Features

- service add --http-port, and recorded in services.list
  ([15e9635](https://github.com/zgeoff/imp/commit/15e96350c47fa25ca3a47c0f4d4568037f782071)), closes
  [#23](https://github.com/zgeoff/imp/issues/23)

## [0.10.0](https://github.com/zgeoff/imp/compare/v0.9.0...v0.10.0) (2026-10-02)

### Features

- **cli:** imp set, imp top, and cpu flags on imp new
  ([#37](https://github.com/zgeoff/imp/issues/37))
  ([326196e](https://github.com/zgeoff/imp/commit/326196ec81a63a6b4f07ec986636fbc99f7d91aa))
- **daemon:** a cpu limit and weight per imp in a cgroup
  ([#37](https://github.com/zgeoff/imp/issues/37))
  ([aa30993](https://github.com/zgeoff/imp/commit/aa309934a8fa1c5c46add0c6d918a6af5c1deb58))
- **daemon:** an imp.disk.used gauge from the disk usage cache
  ([a354387](https://github.com/zgeoff/imp/commit/a354387001aa279e9e09d67a2d21cbeb7b9a3fde)), closes
  [#37](https://github.com/zgeoff/imp/issues/37)
- **daemon:** sample each running imp's cpu, network and memory
  ([#37](https://github.com/zgeoff/imp/issues/37))
  ([9f80607](https://github.com/zgeoff/imp/commit/9f806077ee2cc15bc25d5a13eee0e367c9e7be46))
- **dashboard:** cpu column and a cpu panel with limit form
  ([#37](https://github.com/zgeoff/imp/issues/37))
  ([6e6df94](https://github.com/zgeoff/imp/commit/6e6df94ef59d4569688f21e14a89dfe4deacee9d))
- disk use in imp top and the dashboard ([#37](https://github.com/zgeoff/imp/issues/37))
  ([fb5e019](https://github.com/zgeoff/imp/commit/fb5e0192be7c1a132363bad09af479198725487e))
- **host:** give imps a cgroup tree in a private cgroup namespace
  ([#37](https://github.com/zgeoff/imp/issues/37))
  ([1f96894](https://github.com/zgeoff/imp/commit/1f96894f111dad537a31820858ea61c7aff3c09e))

## [0.9.0](https://github.com/zgeoff/imp/compare/v0.8.0...v0.9.0) (2026-10-02)

### Features

- **images:** upload a build context from the client
  ([38c8c71](https://github.com/zgeoff/imp/commit/38c8c715fb3afc04b2ec0d7ac5eb2a1793ab3efa))

## [0.8.0](https://github.com/zgeoff/imp/compare/v0.7.0...v0.8.0) (2026-10-02)

### Features

- **agent:** kill a stopped command's whole process group
  ([c2b7371](https://github.com/zgeoff/imp/commit/c2b7371f1a2f83b068fbd8c5b4a070beb032e4e1)), closes
  [#51](https://github.com/zgeoff/imp/issues/51)
- **agent:** kill what is left of a stopped exec's process group
  ([f245c56](https://github.com/zgeoff/imp/commit/f245c560e8ecc2493215c6ce4edfe4529f2d34cd))
- an exec takes a kill grace and reports the agent's group kill
  ([fc3e3e8](https://github.com/zgeoff/imp/commit/fc3e3e8c43e2fe8ae0c25ac62caf740f70c575c5))
- **api:** bind ssh keys to tokens in the contract ([#63](https://github.com/zgeoff/imp/issues/63))
  ([3e9a94a](https://github.com/zgeoff/imp/commit/3e9a94aa91d8c51502886aa344cceb0b7261111b))
- **client:** let the caller open the exec socket
  ([35034b7](https://github.com/zgeoff/imp/commit/35034b7c9d8eebb7f1107604c4d1f83c4accf24f))
- **cli:** imp token key add, ls and rm, and new --ssh-key
  ([#63](https://github.com/zgeoff/imp/issues/63))
  ([598da72](https://github.com/zgeoff/imp/commit/598da7273bc57d7932b96131d10b9e0d8fa5da92))
- **daemon:** serve mcp over http at /mcp
  ([63a7ec1](https://github.com/zgeoff/imp/commit/63a7ec1c67db2c91f439c13b032a45b4c539f2dd)), closes
  [#50](https://github.com/zgeoff/imp/issues/50)
- **daemon:** ssh logins with a bound key run as its token
  ([#63](https://github.com/zgeoff/imp/issues/63))
  ([9f45e07](https://github.com/zgeoff/imp/commit/9f45e07956fffaaf4f1d8d72fb3c6d3a03c699d6))
- **daemon:** store ssh keys bound to tokens ([#63](https://github.com/zgeoff/imp/issues/63))
  ([124f67d](https://github.com/zgeoff/imp/commit/124f67dcf634e79ed7952cee19366471a5c3d56c))
- **dashboard:** list the ssh keys bound to each token
  ([#63](https://github.com/zgeoff/imp/issues/63))
  ([f969f0a](https://github.com/zgeoff/imp/commit/f969f0aba80afce60cc2855baa6def8a3b5590c2))
- **deploy:** one-command server bootstrap
  ([7f87178](https://github.com/zgeoff/imp/commit/7f87178b7c491dc901eae830c0a562b8ea8fd957)), closes
  [#9](https://github.com/zgeoff/imp/issues/9)
- **mcp:** add a streamable http transport and a pattern guard
  ([6bd91fa](https://github.com/zgeoff/imp/commit/6bd91fa8ea1b7968abba0c5d7b087411d94681a6))
- **mcp:** let the agent kill a stopped command's process group
  ([753448a](https://github.com/zgeoff/imp/commit/753448ac438ec0a4f561f2faf869bf84d3fb90ec))
- **mcp:** serve mcp over http from impd with scoped tokens
  ([1235313](https://github.com/zgeoff/imp/commit/1235313917b85302bf3af0770f8f23e0a0b0c258)), closes
  [#50](https://github.com/zgeoff/imp/issues/50)
- **ssh:** bind ssh keys to scoped tokens
  ([0436331](https://github.com/zgeoff/imp/commit/0436331cddbdee70ebdab95a7be21be3afc24b1c)), closes
  [#63](https://github.com/zgeoff/imp/issues/63)

### Bug Fixes

- **daemon:** cap long timers at the runtime's limit
  ([abbc951](https://github.com/zgeoff/imp/commit/abbc951dd44f77bd8f7b2f7139d6f1008ffa21e9))
- **daemon:** cap the event stream's end timer at setTimeout's limit
  ([830b437](https://github.com/zgeoff/imp/commit/830b437606e659eedc91368fad7dd741a9a0d882))
- **daemon:** judge /mcp origins by the dashboard's same-origin rule
  ([0e7380d](https://github.com/zgeoff/imp/commit/0e7380da50cc436c717c91001573700612f59453))
- **daemon:** never unbind a key that authorized_keys lists
  ([#63](https://github.com/zgeoff/imp/issues/63))
  ([630ea7c](https://github.com/zgeoff/imp/commit/630ea7c60c12019556b4887bed04608ab03cd09e))
- **db:** number the token ssh keys migration 008
  ([ed3d197](https://github.com/zgeoff/imp/commit/ed3d1971918a0d90843d22f6a65cb39563153dd3))
- **deploy:** refuse zfs when fstab mounts /var/lib/imp
  ([810ba9d](https://github.com/zgeoff/imp/commit/810ba9d6aa6bbee16c0114e8e443e0ceaa96b363))
- **dev:** read the tailscale key from 1password only when a run needs it
  ([7924b0b](https://github.com/zgeoff/imp/commit/7924b0b2ccd17ce8dd9b11a42d9c0fe0ce99de29))
- **e2e:** put the ignore-unknown line before every ssh host block
  ([3df70c0](https://github.com/zgeoff/imp/commit/3df70c0b70752aa79107ae9ccf82340a6f69dbf1))

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
