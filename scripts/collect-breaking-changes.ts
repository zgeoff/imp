import type { MessageDirection, ProtocolSchema } from '../packages/api/src/build-protocol-schema';

type Schema = boolean | Readonly<Record<string, unknown>>;

type SchemaObject = Readonly<Record<string, unknown>>;

// keywords that describe a value without constraining it
const ANNOTATIONS = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

// The keywords read one by one; a change to any other counts as breaking,
// as nothing here can tell which way it goes.
const MODELED = new Set([
  'type',
  'const',
  'enum',
  'anyOf',
  'oneOf',
  'allOf',
  '$ref',
  '$defs',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'items',
  'minItems',
  'maxItems',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
]);

interface Comparison {
  readonly direction: MessageDirection;

  // the roots each side's `$ref` resolves in
  readonly narrowRoot: Schema;
  readonly wideRoot: Schema;

  // the `$ref` pairs already under comparison, which a recursive schema meets again
  readonly seen: ReadonlySet<string>;
}

// The changes from base to head that break a client of the other version, by
// the rules in docs/runbooks/releasing.md#breaking-changes.
export function collectBreakingChanges(base: ProtocolSchema, head: ProtocolSchema): string[] {
  return [
    ...collectProcedureChanges(base, head),
    ...collectMessageChanges(base, head),
    ...collectErrorChanges(base, head),
    ...collectConstantChanges(base, head),
  ];
}

function collectProcedureChanges(base: ProtocolSchema, head: ProtocolSchema): string[] {
  const changes: string[] = [];

  for (const [name, before] of Object.entries(base.procedures)) {
    const after = head.procedures[name];
    const label = `procedure ${name}`;

    if (after === undefined) {
      changes.push(`${label}: removed`);
    } else if (before.stream === after.stream) {
      changes.push(
        ...collectSchemaChanges(`${label} input`, 'toServer', before.input, after.input),
        ...collectSchemaChanges(`${label} output`, 'toClient', before.output, after.output),
      );
    } else {
      changes.push(`${label}: ${formatStream(before.stream)} → ${formatStream(after.stream)}`);
    }
  }

  return changes;
}

function formatStream(stream: boolean): string {
  return stream ? 'event stream' : 'single answer';
}

function collectMessageChanges(base: ProtocolSchema, head: ProtocolSchema): string[] {
  return Object.entries(base.messages).flatMap(([name, before]) => {
    const after = head.messages[name];
    const label = `message ${name}`;

    if (after === undefined) {
      return [`${label}: removed`];
    }

    if (before.direction !== after.direction) {
      return [`${label}: ${before.direction} → ${after.direction}`];
    }

    return collectSchemaChanges(label, before.direction, before.schema, after.schema);
  });
}

function collectErrorChanges(base: ProtocolSchema, head: ProtocolSchema): string[] {
  const changes: string[] = [];

  for (const [code, before] of Object.entries(base.errors)) {
    const after = head.errors[code];
    const label = `error ${code}`;

    if (after === undefined) {
      changes.push(`${label}: removed`);
      continue;
    }

    if (before.status !== after.status) {
      changes.push(`${label}: status ${formatValue(before.status)} → ${formatValue(after.status)}`);
    }

    changes.push(...collectSchemaChanges(`${label} data`, 'toClient', before.data, after.data));
  }

  return changes;
}

function collectConstantChanges(base: ProtocolSchema, head: ProtocolSchema): string[] {
  return Object.entries(base.constants).flatMap(([name, before]) => {
    if (!(name in head.constants)) {
      return [`constant ${name}: removed`];
    }

    const after = head.constants[name];

    return Bun.deepEquals(before, after, true)
      ? []
      : [`constant ${name}: ${formatValue(before)} → ${formatValue(after)}`];
  });
}

function formatValue(value: unknown): string {
  return value === undefined ? 'none' : JSON.stringify(value);
}

// Every value of the narrow side must pass the wide side: base's into head's
// for what impd reads, head's into base's for what it sends.
function collectSchemaChanges(
  label: string,
  direction: MessageDirection,
  before: Schema,
  after: Schema,
): string[] {
  const [narrow, wide] = direction === 'toServer' ? [before, after] : [after, before];
  const comparison = { direction, narrowRoot: narrow, wideRoot: wide, seen: new Set<string>() };

  return collectChanges(narrow, wide, '', comparison).map((change) => `${label}${change}`);
}

function collectChanges(
  narrowRef: Schema,
  wideRef: Schema,
  path: string,
  comparison: Comparison,
): string[] {
  const refKey = `${findRef(narrowRef) ?? ''}|${findRef(wideRef) ?? ''}`;

  if (refKey !== '|' && comparison.seen.has(refKey)) {
    return [];
  }

  const inner =
    refKey === '|' ? comparison : { ...comparison, seen: new Set([...comparison.seen, refKey]) };

  const narrow = resolveRef(narrowRef, comparison.narrowRoot);
  const wide = resolveRef(wideRef, comparison.wideRoot);

  if (isAnything(wide) || narrow === false) {
    return [];
  }

  if (typeof wide === 'boolean' || typeof narrow === 'boolean' || isAnything(narrow)) {
    return [formatChange(path, `accepts ${formatSides(comparison, narrow, wide, formatSchema)}`)];
  }

  return collectObjectChanges(narrow, wide, path, inner);
}

function findRef(schema: Schema): string | undefined {
  return typeof schema === 'object' && typeof schema['$ref'] === 'string'
    ? schema['$ref']
    : undefined;
}

// a local `$ref` (`#/$defs/…`), merged with the keywords beside it
function resolveRef(schema: Schema, root: Schema): Schema {
  const ref = findRef(schema);

  if (typeof schema !== 'object' || ref === undefined) {
    return schema;
  }

  let target: unknown = root;

  for (const part of ref.replace(/^#\/?/u, '').split('/').filter(Boolean)) {
    target = (target as Record<string, unknown> | undefined)?.[decodePointer(part)];
  }

  if (typeof target !== 'object' && typeof target !== 'boolean') {
    throw new TypeError(`unresolved $ref ${ref}`);
  }

  const { $ref: _ref, ...siblings } = schema;
  const resolved = resolveRef(target as Schema, root);

  return Object.keys(siblings).length === 0 || typeof resolved === 'boolean'
    ? resolved
    : { ...resolved, ...siblings };
}

function decodePointer(part: string): string {
  return part.replaceAll('~1', '/').replaceAll('~0', '~');
}

function isAnything(schema: Schema): boolean {
  return (
    schema === true ||
    (typeof schema === 'object' && Object.keys(schema).every((key) => ANNOTATIONS.has(key)))
  );
}

function formatChange(path: string, what: string): string {
  return `${path === '' ? '' : ` ${path}`}: ${what}`;
}

// "base → head", whichever side of the comparison each one is
function formatSides<T>(
  comparison: Comparison,
  narrow: T,
  wide: T,
  format: (value: T) => string,
): string {
  const [before, after] = comparison.direction === 'toServer' ? [narrow, wide] : [wide, narrow];

  return `${format(before)} → ${format(after)}`;
}

function formatSchema(schema: Schema): string {
  if (schema === false) {
    return 'nothing';
  }

  return isAnything(schema) ? 'any value' : 'some values';
}

function collectObjectChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const narrowBranches = readBranches(narrow);

  // a union: each of its options must pass
  if (narrowBranches !== undefined) {
    const siblings = buildWithout(narrow, ['anyOf', 'oneOf']);

    return narrowBranches.flatMap((branch) =>
      collectChanges(mergeSchemas(siblings, branch), wide, path, comparison),
    );
  }

  if (Array.isArray(narrow['allOf'])) {
    return collectIntersectionChanges(narrow, wide, path, comparison);
  }

  if (readValues(narrow) !== undefined) {
    return collectValueChanges(narrow, wide, path, comparison);
  }

  const wideBranches = readBranches(wide);

  if (wideBranches !== undefined) {
    return collectUnionChanges(narrow, wide, wideBranches, path, comparison);
  }

  if (Array.isArray(wide['allOf'])) {
    return [
      ...(wide['allOf'] as Schema[]).flatMap((part) =>
        collectChanges(narrow, part, path, comparison),
      ),
      ...collectChanges(narrow, buildWithout(wide, ['allOf']), path, comparison),
    ];
  }

  return [
    ...collectTypeChanges(narrow, wide, path, comparison),
    ...collectBoundChanges(narrow, wide, path, comparison),
    ...collectStringChanges(narrow, wide, path, comparison),
    ...collectItemChanges(narrow, wide, path, comparison),
    ...collectPropertyChanges(narrow, wide, path, comparison),
    ...collectKeywordChanges(narrow, wide, path, comparison),
  ];
}

function readBranches(schema: SchemaObject): Schema[] | undefined {
  const branches = schema['anyOf'] ?? schema['oneOf'];

  return Array.isArray(branches) ? (branches as Schema[]) : undefined;
}

function buildWithout(schema: SchemaObject, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !keys.includes(key)));
}

function mergeSchemas(siblings: SchemaObject, branch: Schema): Schema {
  return typeof branch === 'boolean' ? branch : { ...siblings, ...branch };
}

// An intersection passes when one of its parts alone does; failing that, the
// first part's changes stand for it.
function collectIntersectionChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const siblings = buildWithout(narrow, ['allOf']);

  const trials = (narrow['allOf'] as Schema[]).map((part) =>
    collectChanges(mergeSchemas(siblings, part), wide, path, comparison),
  );

  const [first = []] = trials;

  return trials.some((trial) => trial.length === 0) ? [] : first;
}

function readValues(schema: Schema): unknown[] | undefined {
  if (typeof schema !== 'object') {
    return undefined;
  }

  if ('const' in schema) {
    return [schema['const']];
  }

  return Array.isArray(schema['enum']) ? schema['enum'] : undefined;
}

// A closed set of values: each must pass, but impd may add one to a closed
// set it sends, as a client passes over a value it does not know.
function collectValueChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  if (comparison.direction === 'toClient' && isClosedSet(wide, comparison.wideRoot)) {
    return [];
  }

  const verb = comparison.direction === 'toServer' ? 'no longer accepts' : 'may now be';

  return (readValues(narrow) ?? [])
    .filter((value) => !isValueAccepted(wide, value, comparison.wideRoot))
    .map((value) => formatChange(path, `${verb} ${formatValue(value)}`));
}

// a schema that admits only listed values: a `const`, an `enum`, or a union of them
function isClosedSet(schemaRef: Schema, root: Schema): boolean {
  const schema = resolveRef(schemaRef, root);

  if (typeof schema !== 'object') {
    return false;
  }

  const branches = readBranches(schema);

  return (
    readValues(schema) !== undefined ||
    (branches !== undefined && branches.every((branch) => isClosedSet(branch, root)))
  );
}

// One option of the wide union must take the whole narrow schema; when none
// does, the closest option's changes are the ones to show.
function collectUnionChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  branches: readonly Schema[],
  path: string,
  comparison: Comparison,
): string[] {
  const siblings = buildWithout(wide, ['anyOf', 'oneOf']);

  const siblingChanges = isAnything(siblings)
    ? []
    : collectChanges(narrow, siblings, path, comparison);

  // A variant whose tag no option shares is a new one, which a client passes
  // over; impd still reads every variant it read before.
  const sameTag = branches.filter(
    (branch) => !hasOtherTag(narrow, resolveRef(branch, comparison.wideRoot)),
  );

  if (sameTag.length === 0) {
    const removed = formatChange(path, `no longer accepts the variant ${formatTag(narrow)}`);

    return comparison.direction === 'toServer' ? [...siblingChanges, removed] : siblingChanges;
  }

  const trials = sameTag.map((branch) => collectChanges(narrow, branch, path, comparison));
  const [closest = []] = trials.toSorted((a, b) => a.length - b.length);

  return [...siblingChanges, ...closest];
}

// whether a property both sides fix to a closed set, such as a discriminated
// union's `type`, takes no value in common: then they are different variants
function hasOtherTag(narrow: SchemaObject, wide: Schema): boolean {
  if (typeof wide !== 'object') {
    return false;
  }

  const narrowProperties = (narrow['properties'] ?? {}) as Readonly<Record<string, Schema>>;
  const wideProperties = (wide['properties'] ?? {}) as Readonly<Record<string, Schema>>;

  return Object.entries(narrowProperties).some(([key, schema]) => {
    const narrowValues = readValues(schema);
    const wideProperty = wideProperties[key];
    const wideValues = wideProperty === undefined ? undefined : readValues(wideProperty);

    return (
      narrowValues !== undefined &&
      wideValues !== undefined &&
      !narrowValues.some((value) => wideValues.some((other) => Bun.deepEquals(value, other, true)))
    );
  });
}

// the first property fixed to a closed set, as `type "stdout_ack"`
function formatTag(schema: SchemaObject): string {
  const properties = (schema['properties'] ?? {}) as Readonly<Record<string, Schema>>;

  for (const [key, property] of Object.entries(properties)) {
    const values = readValues(property);

    if (values !== undefined) {
      return `${key} ${formatValues(values)}`;
    }
  }

  return 'without a tag';
}

function formatValues(values: readonly unknown[] | undefined): string {
  return values === undefined ? 'any' : values.map((value) => formatValue(value)).join(' | ');
}

const JSON_TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'];

function readTypes(schema: SchemaObject): string[] | undefined {
  const type = schema['type'];

  if (typeof type === 'string') {
    return [type];
  }

  return Array.isArray(type) ? (type as string[]) : undefined;
}

// the type, and a closed set that the wide side brings where the narrow had none
function collectTypeChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const wideTypes = readTypes(wide);
  const narrowTypes = readTypes(narrow) ?? JSON_TYPES;
  const wideValues = readValues(wide);

  const fits =
    wideTypes === undefined ||
    narrowTypes.every(
      (type) => wideTypes.includes(type) || (type === 'integer' && wideTypes.includes('number')),
    );

  const typeChange = formatSides(comparison, readTypes(narrow), wideTypes, formatTypes);
  const valueChange = formatSides(comparison, undefined, wideValues, formatValues);

  return [
    ...(fits ? [] : [formatChange(path, `type ${typeChange}`)]),
    ...(wideValues === undefined ? [] : [formatChange(path, `values ${valueChange}`)]),
  ];
}

function formatTypes(types: readonly string[] | undefined): string {
  return types === undefined ? 'any' : types.join(' | ');
}

interface Bound {
  readonly value: number;
  readonly exclusive: boolean;
}

type Side = 'lower' | 'upper';

function collectBoundChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const step = wide['multipleOf'];
  const narrowStep = narrow['multipleOf'];

  const fitsStep =
    typeof step !== 'number' || (typeof narrowStep === 'number' && narrowStep % step === 0);

  const stepChange = formatSides(comparison, narrowStep, step, formatValue);

  const pairs = [
    ['lower bound', readLower(narrow), readLower(wide), 'lower'],
    ['upper bound', readUpper(narrow), readUpper(wide), 'upper'],
    ['min items', readInclusive(narrow, 'minItems'), readInclusive(wide, 'minItems'), 'lower'],
    ['max items', readInclusive(narrow, 'maxItems'), readInclusive(wide, 'maxItems'), 'upper'],
  ] as const;

  return [
    ...pairs.flatMap(([name, narrowBound, wideBound, side]) =>
      collectBoundChange(name, narrowBound, wideBound, side, path, comparison),
    ),
    ...(fitsStep ? [] : [formatChange(path, `multipleOf ${stepChange}`)]),
  ];
}

function readLower(schema: SchemaObject): Bound | undefined {
  const exclusive = schema['exclusiveMinimum'];

  const exclusiveBound =
    typeof exclusive === 'number' ? { value: exclusive, exclusive: true } : undefined;

  return pickTighter(readInclusive(schema, 'minimum'), exclusiveBound, 'lower');
}

function readUpper(schema: SchemaObject): Bound | undefined {
  const exclusive = schema['exclusiveMaximum'];

  const exclusiveBound =
    typeof exclusive === 'number' ? { value: exclusive, exclusive: true } : undefined;

  return pickTighter(readInclusive(schema, 'maximum'), exclusiveBound, 'upper');
}

function readInclusive(schema: SchemaObject, keyword: string): Bound | undefined {
  const value = schema[keyword];

  return typeof value === 'number' ? { value, exclusive: false } : undefined;
}

function pickTighter(a: Bound | undefined, b: Bound | undefined, side: Side): Bound | undefined {
  if (a === undefined || b === undefined) {
    return a ?? b;
  }

  return isWithin(a, b, side) ? a : b;
}

// whether bound `inner` admits no value that bound `outer` refuses
function isWithin(inner: Bound, outer: Bound, side: Side): boolean {
  const ahead = side === 'lower' ? inner.value > outer.value : inner.value < outer.value;

  return ahead || (inner.value === outer.value && (inner.exclusive || !outer.exclusive));
}

function collectBoundChange(
  name: string,
  narrow: Bound | undefined,
  wide: Bound | undefined,
  side: Side,
  path: string,
  comparison: Comparison,
): string[] {
  if (wide === undefined || (narrow !== undefined && isWithin(narrow, wide, side))) {
    return [];
  }

  const change = formatSides(comparison, narrow, wide, (bound) => formatBound(bound, side));

  return [formatChange(path, `${name} ${change}`)];
}

function formatBound(bound: Bound | undefined, side: Side): string {
  if (bound === undefined) {
    return 'none';
  }

  const sign = side === 'lower' ? '>' : '<';

  return `${bound.exclusive ? sign : `${sign}=`} ${String(bound.value)}`;
}

function collectStringChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const lengths = [
    ['min length', readInclusive(narrow, 'minLength'), readInclusive(wide, 'minLength'), 'lower'],
    ['max length', readInclusive(narrow, 'maxLength'), readInclusive(wide, 'maxLength'), 'upper'],
  ] as const;

  const exact = (['pattern', 'format'] as const)
    .filter((keyword) => wide[keyword] !== undefined && narrow[keyword] !== wide[keyword])
    .map((keyword) => {
      const change = formatSides(comparison, narrow[keyword], wide[keyword], formatValue);

      return formatChange(path, `${keyword} ${change}`);
    });

  return [
    ...lengths.flatMap(([name, narrowBound, wideBound, side]) =>
      collectBoundChange(name, narrowBound, wideBound, side, path, comparison),
    ),
    ...exact,
  ];
}

function collectItemChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  if (narrow['items'] === undefined && wide['items'] === undefined) {
    return [];
  }

  const narrowItems = (narrow['items'] as Schema | undefined) ?? true;
  const wideItems = (wide['items'] as Schema | undefined) ?? true;

  return collectChanges(narrowItems, wideItems, `${path}[]`, comparison);
}

function collectPropertyChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const narrowProperties = (narrow['properties'] ?? {}) as Readonly<Record<string, Schema>>;
  const wideProperties = (wide['properties'] ?? {}) as Readonly<Record<string, Schema>>;
  const narrowRequired = (narrow['required'] ?? []) as readonly string[];
  const wideRequired = (wide['required'] ?? []) as readonly string[];
  const wideExtra = wide['additionalProperties'] as Schema | undefined;
  const narrowExtra = narrow['additionalProperties'] as Schema | undefined;
  const recordValues = typeof wideExtra === 'object' ? wideExtra : undefined;
  const missing = comparison.direction === 'toServer' ? 'now required' : 'may now be missing';

  const required = wideRequired
    .filter((key) => !narrowRequired.includes(key))
    .map((key) => formatChange(`${path}.${key}`, missing));

  const properties = Object.entries(narrowProperties).flatMap(([key, schema]) => {
    const wideProperty = wideProperties[key] ?? recordValues;

    if (wideProperty !== undefined) {
      return collectChanges(schema, wideProperty, `${path}.${key}`, comparison);
    }

    return comparison.direction === 'toServer' ? [formatChange(`${path}.${key}`, 'removed')] : [];
  });

  return [
    ...required,
    ...properties,
    ...collectRecordChanges(narrowExtra, wideExtra, path, comparison),
    ...collectKeyChanges(narrow, wide, path, comparison),
  ];
}

// a record's values
function collectRecordChanges(
  narrowExtra: Schema | undefined,
  wideExtra: Schema | undefined,
  path: string,
  comparison: Comparison,
): string[] {
  if (typeof wideExtra === 'object' && typeof narrowExtra === 'object') {
    return collectChanges(narrowExtra, wideExtra, `${path}{}`, comparison);
  }

  const closes =
    comparison.direction === 'toServer' && typeof narrowExtra === 'object' && wideExtra === false;

  return closes ? [formatChange(path, 'no longer takes keys beyond its named properties')] : [];
}

// a record's keys
function collectKeyChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const wideKeys = wide['propertyNames'] as Schema | undefined;

  if (wideKeys === undefined) {
    return [];
  }

  const narrowKeys = (narrow['propertyNames'] as Schema | undefined) ?? { type: 'string' };

  return collectChanges(narrowKeys, wideKeys, `${path}{key}`, comparison);
}

function collectKeywordChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  return Object.entries(wide)
    .filter(
      ([keyword, value]) =>
        !ANNOTATIONS.has(keyword) &&
        !MODELED.has(keyword) &&
        !Bun.deepEquals(narrow[keyword], value, true),
    )
    .map(([keyword, value]) => {
      const change = formatSides(comparison, narrow[keyword], value, formatValue);

      return formatChange(path, `${keyword} ${change}`);
    });
}

// a plain validator for the values of a `const` or an `enum`
function isValueAccepted(schemaRef: Schema, value: unknown, root: Schema): boolean {
  const schema = resolveRef(schemaRef, root);

  if (typeof schema === 'boolean') {
    return schema;
  }

  const branches = readBranches(schema);
  const parts = Array.isArray(schema['allOf']) ? (schema['allOf'] as Schema[]) : [];
  const values = readValues(schema);
  const types = readTypes(schema);

  return (
    (branches === undefined || branches.some((branch) => isValueAccepted(branch, value, root))) &&
    parts.every((part) => isValueAccepted(part, value, root)) &&
    (values === undefined || values.some((option) => Bun.deepEquals(option, value, true))) &&
    (types === undefined || types.some((type) => isOfType(value, type))) &&
    (typeof value !== 'string' || isStringAccepted(schema, value)) &&
    (typeof value !== 'number' || isNumberAccepted(schema, value))
  );
}

function isOfType(value: unknown, type: string): boolean {
  switch (type) {
    case 'integer': {
      return Number.isInteger(value);
    }

    case 'null': {
      return value === null;
    }

    case 'array': {
      return Array.isArray(value);
    }

    case 'object': {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    default: {
      return typeof value === type;
    }
  }
}

function isStringAccepted(schema: SchemaObject, value: string): boolean {
  const length = [...value].length;
  const pattern = schema['pattern'];

  return (
    isInBound(length, readInclusive(schema, 'minLength'), 'lower') &&
    isInBound(length, readInclusive(schema, 'maxLength'), 'upper') &&
    (typeof pattern !== 'string' || new RegExp(pattern, 'u').test(value))
  );
}

function isNumberAccepted(schema: SchemaObject, value: number): boolean {
  const step = schema['multipleOf'];

  return (
    isInBound(value, readLower(schema), 'lower') &&
    isInBound(value, readUpper(schema), 'upper') &&
    (typeof step !== 'number' || value % step === 0)
  );
}

function isInBound(value: number, bound: Bound | undefined, side: Side): boolean {
  return bound === undefined || isWithin({ value, exclusive: false }, bound, side);
}
