// Defers a journey's removal of an imp or image it made; with --keep
// (config.keep) nothing is deferred, so what the journey made stays for a look.
export function registerRemoval(
  stack: Readonly<Pick<AsyncDisposableStack, 'defer'>>,
  keep: boolean,
  remove: () => Promise<void>,
): void {
  if (!keep) {
    stack.defer(remove);
  }
}
