// The value of each line of an env file that sets key, in file order: none
// when no line sets it, and every one when several do.
export function readEnvValues(env: string, key: string): string[] {
  return env
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
}
