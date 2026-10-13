// How long a VM may take to boot and to die: a cold boot's agent must answer
// its first ping within `agentMs`, and impd waits `killMs` for a killed VM's
// process to exit.
export const VM_DEADLINES = { agentMs: 15_000, killMs: 3000 } as const;
