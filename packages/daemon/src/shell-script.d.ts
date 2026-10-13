// A shell script imported as text (`with { type: 'text' }`), which
// `bun build --compile` embeds in the binary.
declare module '*.sh' {
  const text: string;

  export default text;
}
