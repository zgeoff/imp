// The offer's answer refused the send before any byte went: an imp the
// prepare halted runs again
export class OfferRefusalError extends Error {
  override name = 'OfferRefusalError';
}
