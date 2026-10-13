import * as z from 'zod';

// Every key path a zod schema accepts as input, in collectJsonKeyPaths'
// form: each option of a union adds its own, and an array of unknown items
// stops at `a[]`.
export function collectSchemaKeyPaths(schema: z.ZodType): string[] {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });

  return [...new Set(collectNodePaths(JsonSchemaNodeSchema.parse(json), ''))].toSorted();
}

// the parts of a JSON Schema that hold keys
interface JsonSchemaNode {
  readonly properties?: Readonly<Record<string, JsonSchemaNode>> | undefined;
  readonly items?: JsonSchemaNode | undefined;
  readonly anyOf?: readonly JsonSchemaNode[] | undefined;
  readonly oneOf?: readonly JsonSchemaNode[] | undefined;
}

const JsonSchemaNodeSchema: z.ZodType<JsonSchemaNode> = z.lazy(() =>
  z.object({
    properties: z.record(z.string(), JsonSchemaNodeSchema).optional(),
    items: JsonSchemaNodeSchema.optional(),
    anyOf: z.array(JsonSchemaNodeSchema).optional(),
    oneOf: z.array(JsonSchemaNodeSchema).optional(),
  }),
);

function collectNodePaths(node: JsonSchemaNode, prefix: string): string[] {
  const options = [...(node.anyOf ?? []), ...(node.oneOf ?? [])];
  const paths = options.flatMap((option) => collectNodePaths(option, prefix));

  if (node.items !== undefined) {
    const items = `${prefix}[]`;

    paths.push(items, ...collectNodePaths(node.items, items));
  }

  for (const [key, child] of Object.entries(node.properties ?? {})) {
    const path = prefix === '' ? key : `${prefix}.${key}`;

    paths.push(path, ...collectNodePaths(child, path));
  }

  return paths;
}
