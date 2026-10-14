import { ScalarType } from '@bufbuild/protobuf';
import type { DescField, DescFile, DescMessage } from '@bufbuild/protobuf';

// the path of a file's syntax statement in its source code info, which holds
// the comment at the head of the file
const SYNTAX_PATH = 12;

// The Markdown reference for one .proto file: its header comment, then one
// section per message with a row per field, each field under the JSON name
// both sides write.

export function renderProtocolReference(file: DescFile, title: string): string {
  const lines = [
    `# ${title}`,
    '',
    `<!-- Generated from ${file.proto.name} by bun run gen:proto. Edit the schema, not this file. -->`,
    '',
    ...renderComment(findComment(file, [SYNTAX_PATH])),
    'In each table, a field marked always is in every message the agent writes, zero or not; impd leaves a zero out, which reads as zero. A field marked when set appears only when its sender sets it, and a list appears as [] or not at all.',
    '',
  ];

  for (const message of file.messages) {
    lines.push(...renderMessage(file, message));
  }

  return `${lines.join('\n')}\n`;
}

const MESSAGE_PATH = 4;
const FIELD_PATH = 2;

function renderMessage(file: DescFile, message: DescMessage): string[] {
  const path = [MESSAGE_PATH, file.messages.indexOf(message)];

  const rows = message.fields.map((field) => {
    const comment = findComment(file, [...path, FIELD_PATH, message.fields.indexOf(field)]);

    return `| \`${field.name}\` | ${formatType(field)} | ${formatPresence(field)} | ${formatCell(comment)} |`;
  });

  return [
    `## ${message.name}`,
    '',
    ...renderComment(findComment(file, path)),
    ...(rows.length === 0
      ? ['No fields.', '']
      : ['| Field | Type | Presence | Description |', '| --- | --- | --- | --- |', ...rows, '']),
  ];
}

// the leading comment of the declaration at path, as the source code info
// keeps it
function findComment(file: DescFile, path: readonly number[]): string {
  const location = file.proto.sourceCodeInfo?.location.find(
    (candidate) =>
      candidate.path.length === path.length &&
      candidate.path.every((part, index) => part === path[index]),
  );

  return location?.leadingComments.trim() ?? '';
}

function renderComment(comment: string): string[] {
  if (comment === '') {
    return [];
  }

  const lines = comment.split('\n').map((line) => line.replace(/^ /, ''));

  return [...lines, ''];
}

function formatType(field: DescField): string {
  switch (field.fieldKind) {
    case 'scalar': {
      return formatScalar(field.scalar);
    }
    case 'message': {
      return formatMessageLink(field.message);
    }
    case 'list': {
      return `list of ${field.listKind === 'scalar' ? formatScalar(field.scalar) : formatListMember(field)}`;
    }
    case 'enum':
    case 'map': {
      throw new Error(`render-protocol-reference: ${field.name} is a ${field.fieldKind} field`);
    }
  }
}

function formatScalar(scalar: ScalarType): string {
  return scalar === ScalarType.BYTES ? 'bytes (base64)' : ScalarType[scalar].toLowerCase();
}

function formatListMember(field: DescField): string {
  if (field.fieldKind !== 'list' || field.listKind !== 'message') {
    throw new Error(`render-protocol-reference: ${field.name} is not a list of messages`);
  }

  return formatMessageLink(field.message);
}

function formatMessageLink(message: DescMessage): string {
  return `[${message.name}](#${message.name.toLowerCase()})`;
}

// what a reader finds in the JSON: a plain scalar is always written by the
// agent, an optional one and a message only when set, a list as [] or left out
function formatPresence(field: DescField): string {
  if (field.fieldKind === 'list') {
    return 'list';
  }

  if (field.fieldKind === 'message' || field.proto.proto3Optional) {
    return 'when set';
  }

  return 'always';
}

function formatCell(comment: string): string {
  return comment
    .replaceAll('\n', ' ')
    .replaceAll(/\s+/g, ' ')
    .replaceAll('|', String.raw`\|`);
}
