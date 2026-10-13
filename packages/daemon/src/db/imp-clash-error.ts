// An imp insert that met another imp's value in a unique column: `name` is
// the caller's clash, `jail_uid` a race between two creates
export class ImpClashError extends Error {
  override name = 'ImpClashError';

  readonly column: string;

  constructor(column: string) {
    super(`another imp has this ${column}`);

    this.column = column;
  }
}
