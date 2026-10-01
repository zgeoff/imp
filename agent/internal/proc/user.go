package proc

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// LookupUser resolves "", "name", "uid", "name:group" or "uid:gid" against
// the guest's /etc/passwd and /etc/group. os/user would need cgo or NSS
// for anything beyond the files, and the files are all a guest image has.
// It returns nil credentials for root, so the child inherits the agent's.
func LookupUser(spec string) (*syscall.Credential, string, error) {
	if spec == "" || spec == "root" || spec == "0" {
		return nil, "/root", nil
	}
	userPart, groupPart, hasGroup := strings.Cut(spec, ":")

	uid, gid, home := -1, -1, "/"
	if ent, ok := findEntry("/etc/passwd", userPart); ok && len(ent) >= 6 {
		uid, _ = strconv.Atoi(ent[2])
		gid, _ = strconv.Atoi(ent[3])
		home = ent[5]
	} else if n, err := strconv.Atoi(userPart); err == nil {
		uid, gid = n, n
	} else {
		return nil, "", fmt.Errorf("unknown user %q", userPart)
	}

	if hasGroup {
		if ent, ok := findEntry("/etc/group", groupPart); ok && len(ent) >= 3 {
			gid, _ = strconv.Atoi(ent[2])
		} else if n, err := strconv.Atoi(groupPart); err == nil {
			gid = n
		} else {
			return nil, "", fmt.Errorf("unknown group %q", groupPart)
		}
	}
	return &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid), Groups: []uint32{}}, home, nil
}

// findEntry returns the colon-split line of a passwd-style file whose name
// (field 0) or numeric id (field 2) matches key.
func findEntry(path, key string) ([]string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		ent := strings.Split(sc.Text(), ":")
		if len(ent) >= 3 && (ent[0] == key || ent[2] == key) {
			return ent, true
		}
	}
	return nil, false
}
