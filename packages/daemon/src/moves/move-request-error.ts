// A refusal of a `/move/*` request, answered with its HTTP status
export class MoveRequestError extends Error {
  override name = 'MoveRequestError';

  readonly status: number;

  constructor(status: number, message: string) {
    super(message);

    this.status = status;
  }
}
