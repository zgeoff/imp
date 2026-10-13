// T with each field readonly, and each array or object a field holds
// readonly one level down: the shape a caller passes, where a schema's
// inferred type has mutable arrays and records
export type ReadonlyFields<T> = { readonly [Key in keyof T]: ToReadonly<T[Key]> };

type ToReadonly<T> = T extends readonly (infer Item)[]
  ? readonly Item[]
  : T extends object
    ? Readonly<T>
    : T;
