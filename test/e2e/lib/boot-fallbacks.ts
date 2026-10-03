// impd's line when a template restore fails and the imp boots the kernel
// instead. The create still works, so no suite sees it on its own: a ZFS
// host restored no template while every suite passed (#147).
const FALLBACK = /: boot template [0-9a-f]+ failed, booting the kernel/;

// the lines of impd's log where a template restore fell back
export function findBootFallbacks(log: string): string[] {
  return log.split('\n').filter((line) => FALLBACK.test(line));
}
