package services

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
	"time"

	"github.com/zgeoff/imp/agent/internal/fsroot"
	"github.com/zgeoff/imp/agent/internal/proto"
)

// nameRule is the rule for a service added through the API: the name is a
// file name in services.d and in the log dir. impd checks the same rule.
var nameRule = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// checkName keeps a name to the rule, so no op reaches a path outside
// services.d or the log dir
func checkName(name string) error {
	if !nameRule.MatchString(name) {
		return badRequest("name " + name + ": want a lowercase letter or digit, then up to 62 of a-z 0-9 -")
	}
	return nil
}

func badRequest(msg string) error {
	return &proto.Error{Code: proto.ErrBadRequest, Message: msg}
}

func noService(name string) error {
	return &proto.Error{Code: proto.ErrNoService, Message: "no service " + name}
}

// Add writes def to services.d and starts it. A service or file with the
// same name is SERVICE_EXISTS unless replace, which stops it first.
func (s *Supervisor) Add(def Def, replace bool) error {
	if err := checkName(def.Name); err != nil {
		return err
	}
	if err := checkDef(&def); err != nil {
		return badRequest(err.Error())
	}
	def.Source = "api"
	s.opMu.Lock()
	defer s.opMu.Unlock()
	if err := s.refuseStopping(); err != nil {
		return err
	}
	old := s.find(def.Name)
	path := filepath.Join(s.dir, def.Name+".json")
	if !replace {
		if old != nil || exists(s.fsys, path) {
			return &proto.Error{Code: proto.ErrServiceTaken, Message: "service " + def.Name + " exists"}
		}
	}
	if old != nil {
		s.stopOne(old)
		// a replaced file under another name would start it again at boot
		if old.path != "" && old.path != path {
			if err := removeFile(s.fsys, old.path); err != nil {
				return err
			}
		}
	}
	if err := writeDef(s.fsys, path, def); err != nil {
		return err
	}
	s.startAt(def, path)
	return nil
}

// Remove stops a service and deletes its file. Its logs stay.
func (s *Supervisor) Remove(name string) error {
	if err := checkName(name); err != nil {
		return err
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	svc := s.find(name)
	path := filepath.Join(s.dir, name+".json")
	if svc == nil {
		if !exists(s.fsys, path) {
			return noService(name)
		}
		return removeFile(s.fsys, path)
	}
	s.stopOne(svc)
	if svc.path != "" {
		path = svc.path
	}
	return removeFile(s.fsys, path)
}

// Restart stops a service and starts it again from its file, so an edit to
// the file applies; a file written after boot starts for the first time. A
// service whose file is gone restarts as it was.
func (s *Supervisor) Restart(name string) error {
	if err := checkName(name); err != nil {
		return err
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	if err := s.refuseStopping(); err != nil {
		return err
	}
	svc := s.find(name)
	path := filepath.Join(s.dir, name+".json")
	if svc != nil && svc.path != "" {
		path = svc.path
	}
	def, err := readDef(s.fsys, path)
	switch {
	case errors.Is(err, fs.ErrNotExist) && svc != nil:
		def, path = svc.def, svc.path
	case errors.Is(err, fs.ErrNotExist):
		return noService(name)
	case err != nil:
		return badRequest(path + ": " + err.Error())
	}
	if svc != nil {
		s.stopOne(svc)
	}
	s.startAt(def, path)
	return nil
}

func (s *Supervisor) refuseStopping() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping {
		return &proto.Error{Code: proto.ErrPoweringOff, Message: "the services are stopping"}
	}
	return nil
}

func (s *Supervisor) find(name string) *service {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.services[name]
}

// stopOne stops a service as StopAll does, SIGTERM then SIGKILL after
// stopGrace, waits for its loop to return, and forgets it.
func (s *Supervisor) stopOne(svc *service) {
	s.mu.Lock()
	if !isClosed(svc.stop) {
		close(svc.stop)
	}
	if svc.proc != nil {
		svc.proc.Signal(syscall.SIGTERM)
	}
	s.mu.Unlock()

	select {
	case <-svc.done:
	case <-time.After(stopGrace):
		s.mu.Lock()
		if svc.proc != nil {
			svc.proc.Signal(syscall.SIGKILL)
		}
		s.mu.Unlock()
		<-svc.done
	}

	s.mu.Lock()
	if s.services[svc.def.Name] == svc {
		delete(s.services, svc.def.Name)
	}
	s.mu.Unlock()
}

// writeDef writes the file whole or not at all: a temp file, synced, then
// renamed over the old one. The temp name does not end in .json, so a crash
// leaves nothing Load would start.
func writeDef(fsys fsroot.FS, path string, def Def) error {
	// the file name is the name
	def.Name = ""
	b, err := json.MarshalIndent(def, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := fsys.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := fsys.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		f.Close()
		fsys.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		fsys.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		fsys.Remove(tmp)
		return err
	}
	if err := fsys.Rename(tmp, path); err != nil {
		fsys.Remove(tmp)
		return err
	}
	return syncDir(fsys, dir)
}

func removeFile(fsys fsroot.FS, path string) error {
	if err := fsys.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return syncDir(fsys, filepath.Dir(path))
}

func syncDir(fsys fsroot.FS, dir string) error {
	d, err := fsys.OpenFile(dir, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func exists(fsys fsroot.FS, path string) bool {
	_, err := fsys.Stat(path)
	return err == nil
}
