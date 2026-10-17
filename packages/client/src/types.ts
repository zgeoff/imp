// the options a client call takes that the client's own helpers pass on
export interface CallOptions {
  readonly signal?: AbortSignal;
}
