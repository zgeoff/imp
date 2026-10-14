package proto

// Version is the agent protocol version reported by ping.
const Version = "0.18.0"

// Op names.
const (
	OpPing         = "ping"
	OpExec         = "exec"
	OpFreeze       = "freeze"
	OpThaw         = "thaw"
	OpActivity     = "activity"
	OpResumed      = "resumed"
	OpShutdown     = "shutdown"
	OpServicesList = "services.list"
	OpGrow         = "grow"

	// services: add writes a services.d file and starts it, remove stops
	// it and deletes the file, restart re-reads the file, and logs streams
	// the service's log
	OpServicesAdd     = "services.add"
	OpServicesRemove  = "services.remove"
	OpServicesRestart = "services.restart"
	OpServicesLogs    = "services.logs"

	// sessions: exec with a session name starts or attaches one
	OpSessionAttach = "session.attach"
	OpSessionKill   = "session.kill"

	// session.tap reads a logged session's raw output by offset beside its
	// viewer, for impd's output log; an older agent answers UNKNOWN_OP
	OpSessionTap = "session.tap"

	// dial connects to an address in the guest and relays bytes
	OpDial = "dial"

	// ssh-agent forwarding: agent.listen serves a socket for the life of
	// its connection; agent.accept relays one client of that socket
	OpAgentListen = "agent.listen"
	OpAgentAccept = "agent.accept"

	// reverse forwards: listen serves a unix socket or a loopback port, as
	// agent.listen does; agent.accept relays its clients too
	OpListen = "listen"

	// exec.outer runs an exec in the agent's own world, outside the inner
	// container, as root; an older agent answers UNKNOWN_OP
	OpExecOuter = "exec.outer"

	// claim gives a guest restored from a boot template its own identity;
	// only an agent parked in a boot template answers it
	OpClaim = "claim"
)

// The message types are generated from proto/imp/agent/v1/agent.proto into
// agent.pb.go (bun run gen:proto); the names and values below are the strings
// their fields carry.

// Error codes.
const (
	ErrBadRequest = "BAD_REQUEST"
	ErrUnknownOp  = "UNKNOWN_OP"
	ErrExecFailed = "EXEC_FAILED"
	// the inner container, where every process runs, is down
	ErrInnerDown   = "INNER_DOWN"
	ErrFrozen      = "FROZEN"
	ErrPoweringOff = "POWERING_OFF"
	ErrInternal    = "INTERNAL"
	ErrNoSession   = "NO_SESSION"
	// a resume named an offset past the end of the generation it names
	ErrInvalidResume = "INVALID_RESUME"
	ErrSessionCap    = "SESSION_LIMIT"
	ErrDialFailed    = "DIAL_FAILED"
	ErrNoConnection  = "NO_CONNECTION"
	ErrListenFailed  = "LISTEN_FAILED"
	ErrNoService     = "NO_SERVICE"
	ErrServiceTaken  = "SERVICE_EXISTS"
)

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// StageTemplate is Ping.Stage for a guest parked in a boot template.
const StageTemplate = "template"

// Ping.IdentityReset values.
const (
	IdentityResetOK     = "ok"
	IdentityResetFailed = "failed"
)

// StartError is the error for a process that could not start.
func StartError(err error, down bool) *Error {
	if down {
		return &Error{Code: ErrInnerDown, Message: err.Error()}
	}
	return &Error{Code: ErrExecFailed, Message: err.Error()}
}

// Session states.
const (
	SessionRunning = "running"
	SessionExited  = "exited"
)

// Resume kinds.
const (
	ResumeExact             = "exact"
	ResumeGap               = "gap"
	ResumeGenerationChanged = "generation_changed"
)

// Detach reasons.
const (
	DetachTakenOver = "taken_over"
	DetachSlow      = "slow"
)

// ExitOf builds the Exit for a reaped status: signal 0 means a normal exit.
func ExitOf(code, signal int) *Exit {
	if signal != 0 {
		return &Exit{Code: int32(128 + signal), Signal: int32(signal)}
	}
	return &Exit{Code: int32(code)}
}
