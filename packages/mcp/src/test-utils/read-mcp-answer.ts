// The JSON-RPC answer an MCP POST carries: its JSON body, or the one message
// of its event stream that holds a result or an error, past any progress and
// keepalives. Throws when the response carries no answer.
export async function readMcpAnswer(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!(response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    return JSON.parse(text);
  }

  const answer = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line): unknown => JSON.parse(line.slice('data: '.length)))
    .find((message) => isAnswer(message));

  if (answer === undefined) {
    throw new Error(`the event stream carries no answer: ${text}`);
  }

  return answer;
}

function isAnswer(message: unknown): boolean {
  return (
    typeof message === 'object' && message !== null && ('result' in message || 'error' in message)
  );
}
