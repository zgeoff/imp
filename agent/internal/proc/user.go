package proc

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"slices"
	"strconv"
	"strings"
	"syscall"

	"github.com/zgeoff/imp/agent/internal/fsroot"
)

// The account files. Variables so tests can point them at fixtures.
var (
	passwdPath = "/etc/passwd"
	groupPath  = "/etc/group"
)

// LookupUser resolves "", "name", "uid", "name:group" or "uid:gid" against
// the guest's /etc/passwd and /etc/group. os/user would need cgo or NSS
// for anything beyond the files, and the files are all a guest image has.
// It returns nil credentials for root, so the child inherits the agent's.
//
// Supplementary groups follow runc (docker exec -u): a user found in
// /etc/passwd with no group given also gets every group that lists it as a
// member; an explicit group is the only group.
func LookupUser(spec string) (*syscall.Credential, string, error) {
	return LookupUserIn(fsroot.Host, spec)
}

// LookupUserIn is LookupUser against the account files of fsys, such as
// the inner container's root as the agent reaches it.
func LookupUserIn(fsys fsroot.FS, spec string) (*syscall.Credential, string, error) {
	if spec == "" || spec == "root" || spec == "0" {
		return nil, "/root", nil
	}
	userPart, groupPart, hasGroup := strings.Cut(spec, ":")

	var uid, gid uint32
	home, name := "/", ""
	ent, ok, err := findEntry(fsys, passwdPath, userPart)
	switch {
	case err != nil:
		return nil, "", err
	case ok && len(ent) >= 6:
		if uid, err = parseID(passwdPath, ent, 2); err != nil {
			return nil, "", err
		}
		if gid, err = parseID(passwdPath, ent, 3); err != nil {
			return nil, "", err
		}
		home, name = ent[5], ent[0]
	default:
		n, err := strconv.ParseUint(userPart, 10, 32)
		if err != nil {
			return nil, "", fmt.Errorf("unknown user %q", userPart)
		}
		uid, gid = uint32(n), uint32(n)
	}

	if hasGroup {
		ent, ok, err := findEntry(fsys, groupPath, groupPart)
		switch {
		case err != nil:
			return nil, "", err
		case ok:
			if gid, err = parseID(groupPath, ent, 2); err != nil {
				return nil, "", err
			}
		default:
			n, err := strconv.ParseUint(groupPart, 10, 32)
			if err != nil {
				return nil, "", fmt.Errorf("unknown group %q", groupPart)
			}
			gid = uint32(n)
		}
	}

	groups := []uint32{}
	if name != "" && !hasGroup {
		if groups, err = memberGroups(fsys, name, gid); err != nil {
			return nil, "", err
		}
	}
	return &syscall.Credential{Uid: uid, Gid: gid, Groups: groups}, home, nil
}

// memberGroups returns the gids of the groups in /etc/group that list user
// as a member, plus gid, sorted and without duplicates. A missing
// /etc/group means no supplementary groups. A member line with a bad gid is
// logged and skipped: failing would stop every exec and service as that
// user over one typo.
func memberGroups(fsys fsroot.FS, user string, gid uint32) ([]uint32, error) {
	groups := []uint32{gid}
	err := eachEntry(fsys, groupPath, func(ent []string) (bool, error) {
		if len(ent) < 4 || !slices.Contains(strings.Split(ent[3], ","), user) {
			return false, nil
		}
		g, err := parseID(groupPath, ent, 2)
		if err != nil {
			log.Printf("%v; skipping it", err)
			return false, nil
		}
		groups = append(groups, g)
		return false, nil
	})
	if err != nil {
		return nil, err
	}
	slices.Sort(groups)
	return slices.Compact(groups), nil
}

// findEntry returns the colon-split line of a passwd-style file whose name
// (field 0) or numeric id (field 2) matches key. A missing file matches
// nothing.
func findEntry(fsys fsroot.FS, path, key string) ([]string, bool, error) {
	var found []string
	err := eachEntry(fsys, path, func(ent []string) (bool, error) {
		if len(ent) >= 3 && (ent[0] == key || ent[2] == key) {
			found = ent
			return true, nil
		}
		return false, nil
	})
	return found, found != nil, err
}

const maxLine = 1 << 20

// eachEntry calls fn with every colon-split line of path until fn returns
// true or an error. A missing file has no lines.
func eachEntry(fsys fsroot.FS, path string, fn func([]string) (bool, error)) error {
	f, err := fsys.OpenFile(path, os.O_RDONLY, 0)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	// A big group's member list can pass bufio's 64 KiB default line limit.
	sc.Buffer(nil, maxLine)
	for sc.Scan() {
		if stop, err := fn(strings.Split(sc.Text(), ":")); stop || err != nil {
			return err
		}
	}
	return sc.Err()
}

// parseID reads the numeric field i of ent. A bad id is an error, never a
// silent 0: 0 is root.
func parseID(path string, ent []string, i int) (uint32, error) {
	n, err := strconv.ParseUint(ent[i], 10, 32)
	if err != nil {
		return 0, fmt.Errorf("%s: %s: bad id %q", path, ent[0], ent[i])
	}
	return uint32(n), nil
}
