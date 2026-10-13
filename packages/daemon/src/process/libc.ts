import { FFIType, dlopen, read } from 'bun:ffi';
import type { ConvertFns, Symbols } from 'bun:ffi';

// the libc calls impd makes through bun:ffi
const CORE_SYMBOLS = {
  ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  lseek: { args: [FFIType.i32, FFIType.i64, FFIType.i32], returns: FFIType.i64 },

  // libc's name for the thread's errno
  __errno_location: { args: [], returns: FFIType.ptr },
} as const;

// glibc 2.36's pidfd wrappers, apart: an older libc lacks them, and the core
// calls must still load there
const PIDFD_SYMBOLS = {
  pidfd_open: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  pidfd_send_signal: {
    args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
} as const;

type CoreLibc = ConvertFns<typeof CORE_SYMBOLS>;

type PidfdLibc = ConvertFns<typeof PIDFD_SYMBOLS>;

const opened: { core?: CoreLibc | null; pidfd?: PidfdLibc | null } = {};

// libc's ioctl, lseek and errno, opened once on first use; null where libc
// cannot be opened
export function getLibc(): CoreLibc | null {
  // undefined until the first open; null caches a failed one
  if (opened.core === undefined) {
    opened.core = openSymbols(CORE_SYMBOLS);
  }

  return opened.core;
}

// libc's pidfd wrappers, opened once on first use; null where they are
// missing
export function getPidfdLibc(): PidfdLibc | null {
  if (opened.pidfd === undefined) {
    opened.pidfd = openSymbols(PIDFD_SYMBOLS);
  }

  return opened.pidfd;
}

// The calling thread's errno, as the last failed libc call left it; -1 when
// libc is not open.
export function readErrno(): number {
  // oxlint-disable-next-line no-underscore-dangle -- libc's name for the thread's errno
  const at = getLibc()?.__errno_location();

  return at === null || at === undefined ? -1 : read.i32(at);
}

function openSymbols<T extends Symbols>(symbols: T): ConvertFns<T> | null {
  try {
    return dlopen('libc.so.6', symbols).symbols;
  } catch {
    return null;
  }
}
