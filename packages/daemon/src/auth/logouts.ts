// Ends the dashboard's event streams at a logout. Sessions are signed, not
// stored, so a logout cannot name the one it ends: it ends every dashboard
// stream, and a browser whose session is still valid reconnects.
export function createLogouts() {
  let controller = new AbortController();

  return {
    // aborts at the next logout
    readSignal: (): AbortSignal => controller.signal,
    logOut: (): void => {
      controller.abort();

      controller = new AbortController();
    },
  };
}
