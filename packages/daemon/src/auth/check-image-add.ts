import { ImageRefSchema, isImpAllowed } from '@impz/api';
import type { Refusal } from './access-policy';
import { formatCaller } from './caller';
import type { Caller } from './caller';

// the fields of an image add's input the check reads; the input is not
// checked yet, so a field that is not a string reads as null
interface ImageAddFields {
  readonly ref: string | null;
  readonly name: string | null;

  // the input holds an `imp`, as a template copy does
  readonly hasImp: boolean;
}

// a ref pinned by digest, which names one image for good; a tag can move
const PINNED_REF = /@sha256:[0-9a-f]{64}$/u;

// The caller's prefix, a ref that starts with it and is pinned, and a name
// within the caller's patterns.
export function checkImageAdd(
  caller: Readonly<Caller>,
  patterns: readonly string[],
  fields: Readonly<ImageAddFields>,
): Refusal | null {
  const who = formatCaller(caller);
  const prefix = caller.imageRefPrefix;

  if (prefix === null) {
    return { message: `${who} is limited to some imps; this call is host-wide`, reason: null };
  }

  const ref = fields.ref;

  if (ref === null || fields.hasImp) {
    return { message: `${who} may add only an image from a ref, not a template`, reason: null };
  }

  // the input is parsed after this check, and an `imp` beside a ref that
  // fails its schema would parse as a template copy of that imp
  if (!ImageRefSchema.safeParse(ref).success) {
    return { message: `${who} may add only an image from a valid ref`, reason: null };
  }

  const name = fields.name;

  if (name === null) {
    return {
      message: `${who} is limited to some imps, so the call must name the image (name)`,
      reason: 'imp_out_of_scope',
    };
  }

  if (!isImpAllowed(patterns, name)) {
    return { message: `${who} may not add image ${name}`, reason: 'imp_out_of_scope' };
  }

  if (!ref.startsWith(prefix)) {
    return { message: `${who} may add only images whose ref starts with ${prefix}`, reason: null };
  }

  if (!PINNED_REF.test(ref)) {
    return {
      message: `${who} may add only an image ref pinned by digest, such as ${prefix}app@sha256:…`,
      reason: null,
    };
  }

  return null;
}
