// What keeps an imp awake (DESIGN 2.9). An open proxied connection also
// shows in `tcpEstablished`; the proxy sends `Connection: close` upstream, so
// a finished request leaves no keep-alive socket in the guest to count.
export interface IdleSignals {
  readonly execSessions: number;
  readonly proxyConnections: number;

  // authenticated SSH connections, with or without a channel open
  readonly sshConnections: number;

  // `imp proxy` connections
  readonly tunnelConnections: number;
  readonly tcpEstablished: number;

  // percent of one core since the last sample; null on the first sample
  readonly cpuPercent: number | null;
  readonly holdUntil: number | null;
  readonly lastActiveAt: number;
}

interface IdleSettings {
  readonly now: number;
  readonly idleTimeoutMs: number;
  readonly cpuPercent: number;
}

interface IdleDecision {
  // why the imp counts as active now, or null when it is idle
  readonly activeReason: string | null;
  readonly sleep: boolean;
}

export function checkIdle(signals: IdleSignals, settings: IdleSettings): IdleDecision {
  const activeReason = findActiveReason(signals, settings);

  return {
    activeReason,
    sleep: activeReason === null && settings.now - signals.lastActiveAt >= settings.idleTimeoutMs,
  };
}

function findActiveReason(signals: IdleSignals, settings: IdleSettings): string | null {
  if (signals.holdUntil !== null && signals.holdUntil > settings.now) {
    return 'hold';
  }

  if (signals.execSessions > 0) {
    return 'exec';
  }

  if (signals.proxyConnections > 0) {
    return 'proxy';
  }

  if (signals.sshConnections > 0) {
    return 'ssh';
  }

  if (signals.tunnelConnections > 0) {
    return 'tunnel';
  }

  if (signals.tcpEstablished > 0) {
    return 'tcp';
  }

  if (signals.cpuPercent !== null && signals.cpuPercent > settings.cpuPercent) {
    return 'cpu';
  }

  return null;
}
