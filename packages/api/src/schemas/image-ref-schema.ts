import * as z from 'zod';

// The OCI reference grammar (distribution/reference): [domain/]path[:tag][@digest].
// Every component starts with a letter or digit, so a ref can never reach
// docker's argv as a flag.
const DOMAIN_COMPONENT = String.raw`(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])`;
const DOMAIN = String.raw`${DOMAIN_COMPONENT}(?:\.${DOMAIN_COMPONENT})*(?::[0-9]+)?`;
const PATH_COMPONENT = String.raw`[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*`;
const TAG = String.raw`[\w][\w.-]{0,127}`;
const DIGEST = String.raw`[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,}`;

const REFERENCE = new RegExp(
  String.raw`^(?:${DOMAIN}/)?${PATH_COMPONENT}(?:/${PATH_COMPONENT})*(?::${TAG})?(?:@${DIGEST})?$`,
);

export const ImageRefSchema = z
  .string()
  .max(255)
  .regex(REFERENCE, 'must be an image reference such as ubuntu:24.04 or ghcr.io/org/app@sha256:…');
