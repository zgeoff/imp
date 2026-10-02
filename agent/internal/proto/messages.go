package proto

// Version is the agent protocol version reported by ping.
const Version = "0.6.0"

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

	// sessions: exec with a session name starts or attaches one
	OpSessionAttach = "session.attach"
	OpSessionKill   = "session.kill"

	// dial connects to an address in the guest and relays bytes
	OpDial = "dial"

	// ssh-agent forwarding: agent.listen serves a socket for the life of
	// its connection; agent.accept relays one client of that socket
	OpAgentListen = "agent.listen"
	OpAgentAccept = "agent.accept"
)

// Request is the first frame on every connection. Fields beyond Op are
// op-specific; unused ones are omitted.
type Request struct {
	Op string `json:"op"`

	// exec
	Argv []string `json:"argv,omitempty"`
	Env  []string `json:"env,omitempty"`
	Cwd  string   `json:"cwd,omitempty"`
	TTY  bool     `json:"tty,omitempty"`
	Cols uint16   `json:"cols,omitempty"`
	Rows uint16   `json:"rows,omitempty"`
	User string   `json:"user,omitempty"`

	// exec, session.attach, session.kill: the session name
	Session string `json:"session,omitempty"`

	// freeze: auto-thaw after this many ms (default 30000)
	TimeoutMs int64 `json:"timeout_ms,omitempty"`

	// resumed
	UnixMs int64 `json:"unix_ms,omitempty"`

	// dial: "tcp" with "host:port", or "unix" with a socket path
	Network string `json:"network,omitempty"`
	Address string `json:"address,omitempty"`

	// agent.accept: the listener and the connection a CONNECTION named
	Listener   string `json:"listener,omitempty"`
	Connection uint64 `json:"connection,omitempty"`

	// grow: the disk's new size in bytes
	DiskBytes int64 `json:"disk_bytes,omitempty"`
}

// Error codes.
const (
	ErrBadRequest   = "BAD_REQUEST"
	ErrUnknownOp    = "UNKNOWN_OP"
	ErrExecFailed   = "EXEC_FAILED"
	ErrFrozen       = "FROZEN"
	ErrPoweringOff  = "POWERING_OFF"
	ErrInternal     = "INTERNAL"
	ErrNoSession    = "NO_SESSION"
	ErrSessionCap   = "SESSION_LIMIT"
	ErrDialFailed   = "DIAL_FAILED"
	ErrNoConnection = "NO_CONNECTION"
)

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// ErrorResponse is the RESPONSE payload for a failed request.
type ErrorResponse struct {
	Error *Error `json:"error"`
}

type Ping struct {
	OK      bool   `json:"ok"`
	Version string `json:"version"`
	// nil when the guest clock cannot be read: impd then skips its
	// young-guest wait before a sleep
	UptimeMs *int64 `json:"uptime_ms,omitempty"`
}

type OK struct {
	OK bool `json:"ok"`
}

// AgentListen is the RESPONSE to agent.listen.
type AgentListen struct {
	OK bool `json:"ok"`
	// Path is the socket for SSH_AUTH_SOCK.
	Path     string `json:"path"`
	Listener string `json:"listener"`
}

// Connection is the CONNECTION payload: a client is waiting on the socket
// for an agent.accept with this id.
type Connection struct {
	ID uint64 `json:"id"`
}

type Activity struct {
	TCPEstablished int `json:"tcp_established"`
	// ExecSessions counts open exec and session.attach connections.
	ExecSessions int           `json:"exec_sessions"`
	Load1        float64       `json:"load1"`
	Sessions     []SessionInfo `json:"sessions"`
}

// Session states.
const (
	SessionRunning = "running"
	SessionExited  = "exited"
)

type SessionInfo struct {
	Name     string   `json:"name"`
	Pid      int      `json:"pid"`
	Argv     []string `json:"argv"`
	State    string   `json:"state"`
	Attached bool     `json:"attached"`
	Cols     uint16   `json:"cols"`
	Rows     uint16   `json:"rows"`
	// StartedUnixMs is the guest wall clock when the session started.
	StartedUnixMs int64 `json:"started_unix_ms"`
	// Exit is set once the process exited and its output drained.
	Exit *Exit `json:"exit,omitempty"`
}

type ServiceStatus struct {
	Name     string `json:"name"`
	State    string `json:"state"` // running, backoff, stopped, exited
	Pid      int    `json:"pid,omitempty"`
	Restarts int    `json:"restarts"`
	LastExit *Exit  `json:"last_exit,omitempty"`
}

type ServicesList struct {
	Services []ServiceStatus `json:"services"`
}

type Started struct {
	Pid int `json:"pid"`
	// Session and Created are set on a session connection; Created is false
	// when the connection attached to a session that already ran.
	Session string `json:"session,omitempty"`
	Created bool   `json:"created,omitempty"`
}

// Detached is why the guest ended a session connection without an EXIT.
type Detached struct {
	Reason string `json:"reason"`
}

// Detach reasons.
const (
	DetachTakenOver = "taken_over"
	DetachSlow      = "slow"
)

type Resize struct {
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

type Signal struct {
	Signal int `json:"signal"`
}

// Exit reports how a process ended. When Signal is set, Code is 128+Signal,
// as a shell reports it.
type Exit struct {
	Code   int `json:"code"`
	Signal int `json:"signal"`
}

// ExitOf builds the Exit for a reaped status: signal 0 means a normal exit.
func ExitOf(code, signal int) Exit {
	if signal != 0 {
		return Exit{Code: 128 + signal, Signal: signal}
	}
	return Exit{Code: code}
}
