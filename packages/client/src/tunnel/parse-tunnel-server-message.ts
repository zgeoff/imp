import { TunnelServerMessageSchema } from '@impz/api';
import type { TunnelServerMessage } from '@impz/api';

// A text message from impd's `/tunnel`, or null for one that breaks the
// protocol, which closes the tunnel with TUNNEL_CLOSE_PROTOCOL.
export function parseTunnelServerMessage(text: string): TunnelServerMessage | null {
  try {
    const parsed = TunnelServerMessageSchema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
