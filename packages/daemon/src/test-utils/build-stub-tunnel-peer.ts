import type { TunnelPeer } from '../tunnel/tunnel-session';

// The client's end of one `/tunnel` socket: it parses each text message as
// the JSON the protocol sends, decodes each binary one, and keeps the code
// and reason of the close (null until the session closes it).
export function buildStubTunnelPeer() {
  const sent: unknown[] = [];
  const binary: string[] = [];
  const closed: { code: number | null; reason: string } = { code: null, reason: '' };

  const peer: TunnelPeer = {
    sendText: (text) => {
      sent.push(JSON.parse(text));
    },
    sendBinary: (data) => {
      binary.push(new TextDecoder().decode(data));
    },
    close: (code, reason) => {
      closed.code = code;
      closed.reason = reason;
    },
  };

  return { peer, sent, binary, closed };
}
