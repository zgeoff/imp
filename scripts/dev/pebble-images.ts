// Let's Encrypt's test CA and the DNS server it asks, pinned by digest. The
// e2e Pebble stack runs them, and scripts/dev/pull-pebble-images.ts pulls them
// before `bun run test:pebble`.
export const PEBBLE_IMAGES = {
  pebble:
    'ghcr.io/letsencrypt/pebble:2.10.1@sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199',
  challtestsrv:
    'ghcr.io/letsencrypt/pebble-challtestsrv:2.10.1@sha256:12ce21884def456bcf9786542113949e1f19dc7738d2c70e156c2d0c38a1405b',
} as const;
