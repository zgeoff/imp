package boot

import (
	"regexp"
	"testing"
)

// the shape of /proc/sys/kernel/random/boot_id: a version 4 UUID
var bootIDShape = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// Every copy of a boot template shares the kernel's boot_id, so each claim
// must name its boot anew: two copies, or two boots of one imp, differ.
func TestNewBootIDIsAFreshUUID(t *testing.T) {
	seen := map[string]bool{}
	for range 64 {
		id := newBootID()
		if !bootIDShape.MatchString(id) {
			t.Fatalf("boot id %q is not a version 4 UUID", id)
		}
		if seen[id] {
			t.Fatalf("boot id %q repeated", id)
		}
		seen[id] = true
	}
}
