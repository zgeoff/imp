import type { DescMessage } from '@bufbuild/protobuf';

// Every key path of a message in its JSON form under the schema's field
// names, in collectJsonKeyPaths' form: `a`, `a.b`, and `a[]` for a list's
// items, so `a[].b` for a field of a message in a list.
export function collectMessageKeyPaths(schema: DescMessage, prefix = ''): string[] {
  const paths = schema.fields.flatMap((field) => {
    const path = prefix === '' ? field.name : `${prefix}.${field.name}`;

    if (field.fieldKind === 'message') {
      return [path, ...collectMessageKeyPaths(field.message, path)];
    }

    if (field.fieldKind === 'list') {
      const items = `${path}[]`;

      return field.listKind === 'message'
        ? [path, items, ...collectMessageKeyPaths(field.message, items)]
        : [path, items];
    }

    return [path];
  });

  return paths.toSorted();
}
