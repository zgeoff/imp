package boot

import (
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

// Every copy of a boot template shares the kernel's boot_id, so each claim
// must name its boot anew: two copies, or two boots of one imp, differ.
func TestNewBootIDIsAFreshVersion4UUIDEachCall(t *testing.T) {
	// the shape of /proc/sys/kernel/random/boot_id: a version 4 UUID
	const shape = `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`

	ids := make([]string, 64)
	for i := range ids {
		ids[i] = newBootID()
	}

	seen := map[string]bool{}
	for _, id := range ids {
		assert.Check(t, cmp.Regexp(shape, id))
		seen[id] = true
	}
	assert.Check(t, cmp.Len(seen, len(ids)), "a boot id repeated: %v", ids)
}
