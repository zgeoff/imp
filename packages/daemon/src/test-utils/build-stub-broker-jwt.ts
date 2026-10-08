// An unsigned JWT that carries `claims`: the broker decodes ID and access
// tokens without verifying them, so the signature is a fixed placeholder.
export function buildStubBrokerJwt(claims: unknown): string {
  return `${encodeSegment({ alg: 'none' })}.${encodeSegment(claims)}.fake`;
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
