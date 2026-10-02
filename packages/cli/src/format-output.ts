import type { Checkpoint, Image, Imp } from '@imp/api';

type Row = readonly string[];

export function formatTable(header: Row, rows: readonly Row[]): string {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );

  return [header, ...rows]
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export function formatImps(imps: readonly Imp[]): string {
  return formatTable(
    ['NAME', 'STATE', 'IMAGE', 'VCPUS', 'MEMORY', 'RAM', 'IP', 'URL', 'NOTE'],
    imps.map((imp) => [
      imp.name,
      imp.state,
      imp.image,
      String(imp.vcpus),
      `${String(imp.memoryMib)} MiB`,
      imp.ramMib === undefined ? '-' : `${String(imp.ramMib)} MiB`,
      imp.ip,
      imp.url,
      formatNote(imp),
    ]),
  );
}

// what an upgrade means for the imp (docs/guides/operations.md#upgrade)
function formatNote(imp: Imp): string {
  const notes: string[] = [];

  if (imp.coldBootReason !== undefined) {
    const when = imp.state === 'sleeping' ? 'boots cold' : 'booted cold';

    notes.push(`${when}: ${imp.coldBootReason}`);
  }

  if (imp.outdated !== undefined) {
    notes.push(`outdated: ${imp.outdated.join(', ')}`);
  }

  return notes.join('; ');
}

export function formatCheckpoints(checkpoints: readonly Checkpoint[]): string {
  return formatTable(
    ['ID', 'LABEL', 'CREATED', 'SIZE'],
    checkpoints.map((checkpoint) => [
      checkpoint.id,
      checkpoint.label ?? '',
      checkpoint.createdAt.toISOString(),
      checkpoint.sizeBytes === undefined
        ? ''
        : `${String(Math.round(checkpoint.sizeBytes / 1_048_576))} MiB`,
    ]),
  );
}

export function formatImages(images: readonly Image[]): string {
  return formatTable(
    ['NAME', 'REF', 'DIGEST', 'SIZE'],
    images.map((image) => [
      image.name,
      image.ref,
      image.digest.slice(0, 19),
      `${String(Math.round(image.sizeBytes / 1_048_576))} MiB`,
    ]),
  );
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
