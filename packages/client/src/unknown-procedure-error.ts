// impd has no procedure at this path, as an impd older than this client
// lacks the procedures added since. impd answers it with a plain-text 404,
// which oRPC cannot parse, so the client names it instead.
export class UnknownProcedureError extends Error {
  // the procedure's path, e.g. `events.stream`
  readonly procedure: string;

  constructor(procedure: string) {
    super(`impd has no procedure ${procedure}`);

    this.name = 'UnknownProcedureError';
    this.procedure = procedure;
  }
}
