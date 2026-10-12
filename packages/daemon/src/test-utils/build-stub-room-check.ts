// The disk budget's `requireRoom` for a disk that fills: the first `passes`
// checks find room, and every later one rejects with `error`, as the real
// check does at the reserve. `asked` records each check's bytes in order.
export function buildStubRoomCheck(options: Readonly<{ passes: number; error: Error }>) {
  const asked: number[] = [];

  const requireRoom = (bytes: number): Promise<void> => {
    asked.push(bytes);

    return asked.length > options.passes ? Promise.reject(options.error) : Promise.resolve();
  };

  return { requireRoom, asked };
}
