// Command ksm-exec lets KSM merge the memory of the program it runs. impd
// starts the Firecracker jailer, or Firecracker itself with the jailer off,
// through it when IMP_KSM is on:
//
//	setsid ksm-exec jailer --id <imp> --exec-file firecracker ...
//
// It sets PR_SET_MEMORY_MERGE and execs the program in place. Linux 6.10 or
// later keeps the flag across each exec, the jailer's into Firecracker too,
// so every anonymous mapping Firecracker makes, guest memory included, is
// mergeable. ksm-exec runs outside the jail's chroot. Firecracker's seccomp
// filter traps prctl, so it cannot set the flag itself
// (docs/architecture/sleep-and-wake.md#8-ksm-sharing-identical-guest-pages).
package main

import (
	"fmt"
	"os"
	"os/exec"

	"golang.org/x/sys/unix"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: ksm-exec PROGRAM [ARG...]")
		os.Exit(2)
	}

	err := runMerged(os.Args[1:])
	fmt.Fprintf(os.Stderr, "ksm-exec: %v\n", err)
	os.Exit(1)
}

// runMerged sets the merge flag and execs argv; it returns only on failure.
func runMerged(argv []string) error {
	if err := unix.Prctl(unix.PR_SET_MEMORY_MERGE, 1, 0, 0, 0); err != nil {
		return fmt.Errorf("prctl PR_SET_MEMORY_MERGE (needs CONFIG_KSM): %w", err)
	}

	path, err := exec.LookPath(argv[0])
	if err != nil {
		return err
	}

	return unix.Exec(path, argv, os.Environ())
}
