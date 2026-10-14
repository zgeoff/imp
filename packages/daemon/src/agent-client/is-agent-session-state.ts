// whether a session state from the agent is one impd knows: running, or
// exited once the process ended and its output drained
export function isAgentSessionState(state: string): state is 'running' | 'exited' {
  return state === 'running' || state === 'exited';
}
