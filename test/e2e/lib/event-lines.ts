import * as z from 'zod';

const EventLineSchema = z.object({
  ev: z.string(),
  reason: z.string().optional(),
  name: z.string().optional(),
  imp: z.object({ name: z.string(), state: z.string() }).optional(),
});

// One line `imp events` prints, as `name ev reason`; a snapshot line ends with
// the imp's state. A governor decision is null, since it depends on what else
// is awake.
export function formatEventLine(line: string): string | null {
  const event = EventLineSchema.parse(JSON.parse(line));

  if (event.ev === 'GovernorDecision') {
    return null;
  }

  const words = [
    event.imp?.name ?? event.name,
    event.ev,
    event.reason,
    event.reason === 'snapshot' ? event.imp?.state : undefined,
  ];

  return words.filter((word) => word !== undefined).join(' ');
}

// Passes each formatted line of an `imp events` stdout to `onLine` as it
// comes, until the stream ends.
export async function collectEventLines(
  stdout: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();

  let buffered = '';

  for await (const chunk of stdout) {
    buffered += decoder.decode(chunk, { stream: true });

    const lines = buffered.split('\n');

    buffered = lines.pop() ?? '';

    for (const line of lines) {
      const formatted = formatEventLine(line);

      if (formatted !== null) {
        onLine(formatted);
      }
    }
  }
}
