import type { Access } from './access-policy';
import { readField } from './access-policy';

// the host-wide calls that change an imp, and the fields that name it
const HOST_IMP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'imps.expose': ['name'],
  'imps.unexpose': ['name'],
  'networks.join': ['name'],
  'networks.leave': ['name'],
  'images.add': ['imp'],
  'moves.reissue': ['name'],
};

// The imps a call changes, which an image builder refuses but for rm
// (docs/guides/images.md#isolated-builds). A read changes nothing.
export function readChangedImps(
  procedure: string,
  access: Readonly<Access> | null,
  input: unknown,
): string[] {
  if (access === null || access.scope === 'read' || procedure === 'imps.destroy') {
    return [];
  }

  const fields =
    access.on === 'imp' || access.on === 'grant' ? access.fields : HOST_IMP_FIELDS[procedure];

  return (fields ?? []).flatMap((field) => readField(input, field) ?? []);
}
