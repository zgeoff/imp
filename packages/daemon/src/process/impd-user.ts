// The user impd runs as: root in the host container. It owns the files of an
// unjailed VM, and a jail never maps a VM to it.
export const IMPD_USER = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 } as const;
