package proto

// Version is the agent protocol version reported by ping.
const Version = "0.13.0"

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

	// dial connects to an address in the guest and relays bytes
	OpDial = "dial"

	// ssh-agent forwarding: agent.listen serves a socket for the life of
	// its connection; agent.accept relays one client of that socket
	OpAgentListen = "agent.listen"
	OpAgentAccept = "agent.accept"

	// reverse forwards: listen serves a unix socket or a loopback port, as
	// agent.listen does; agent.accept relays its clients too
	OpListen = "listen"

	// claim gives a guest restored from a boot template its own identity;
	// only stage 1, parked in a template, answers it
	OpClaim = "claim"
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

	// exec: once a host stop signal arrives and the process exits, the rest
	// of its process group gets this long, counted from the signal, before
	// SIGKILL. 0 leaves the group alone.
	KillGraceMs int64 `json:"kill_grace_ms,omitempty"`

	// exec, session.attach, session.kill: the session name
	Session string `json:"session,omitempty"`

	// freeze: auto-thaw after this many ms (default 30000)
	TimeoutMs int64 `json:"timeout_ms,omitempty"`

	// resumed
	UnixMs int64 `json:"unix_ms,omitempty"`

	// dial: "tcp" with "host:port", or "unix" with a socket path; listen:
	// "tcp" with "127.0.0.1:port", or "unix" with a path or "" for one the
	// agent makes
	Network string `json:"network,omitempty"`
	Address string `json:"address,omitempty"`

	// agent.accept: the listener and the connection a CONNECTION named
	Listener   string `json:"listener,omitempty"`
	Connection uint64 `json:"connection,omitempty"`

	// grow: the disk's new size in bytes
	DiskBytes int64 `json:"disk_bytes,omitempty"`

	// claim: the values a cold boot reads from the kernel cmdline, and more
	Claim *Claim `json:"claim,omitempty"`

	// services.remove, services.restart, services.logs: the service name
	Service string `json:"service,omitempty"`

	// services.add: the definition, and whether it may replace one
	Def     *ServiceDef `json:"def,omitempty"`
	Replace bool        `json:"replace,omitempty"`

	// services.logs: how many lines of the log to send first, or with a
	// cursor everything after it, and whether to keep sending what the
	// service writes
	Lines  int        `json:"lines,omitempty"`
	Follow bool       `json:"follow,omitempty"`
	Cursor *LogCursor `json:"cursor,omitempty"`
}

// LogCursor is a place in a service's log: the file, by inode, and the
// offset after the last byte sent.
type LogCursor struct {
	Inode  uint64 `json:"inode"`
	Offset int64  `json:"offset"`
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
	ErrListenFailed = "LISTEN_FAILED"
	ErrNoService    = "NO_SERVICE"
	ErrServiceTaken = "SERVICE_EXISTS"
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
	// set on a boot that reset a template copy's identity: ok, or failed
	// when impd must ask again on the next boot
	IdentityReset string `json:"identity_reset,omitempty"`
	// "template" while stage 1 waits for a claim; empty once stage 2 runs
	Stage string `json:"stage,omitempty"`
}

// StageTemplate is Ping.Stage for a guest parked in a boot template.
const StageTemplate = "template"

// Claim is what a guest restored from a boot template needs to become one
// imp (docs/architecture/boot-templates.md#claim). The seed is mixed into
// the kernel's entropy pool before the CRNG reseeds.
type Claim struct {
	ID            string   `json:"id"`
	Hostname      string   `json:"hostname"`
	IP            string   `json:"ip"`
	GW            string   `json:"gw"`
	IP6           string   `json:"ip6,omitempty"`
	GW6           string   `json:"gw6,omitempty"`
	DNS           []string `json:"dns,omitempty"`
	MAC           string   `json:"mac"`
	UnixMs        int64    `json:"unix_ms"`
	Seed          []byte   `json:"seed"`
	ResetIdentity bool     `json:"reset_identity,omitempty"`
}

// Ping.IdentityReset values.
const (
	IdentityResetOK     = "ok"
	IdentityResetFailed = "failed"
)

type OK struct {
	OK bool `json:"ok"`
}

// Listening is the RESPONSE to agent.listen and listen.
type Listening struct {
	OK bool `json:"ok"`
	// Path is the unix socket (for agent.listen, SSH_AUTH_SOCK); Port the
	// TCP port, which a request for port 0 learns here
	Path     string `json:"path,omitempty"`
	Port     int    `json:"port,omitempty"`
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

// ServiceDef is one services.d file. Name is the file name without .json;
// a name field in the file is ignored. Restart defaults to "always".
type ServiceDef struct {
	Name string   `json:"name,omitempty"`
	Argv []string `json:"argv"`
	Env  []string `json:"env,omitempty"`
	Cwd  string   `json:"cwd,omitempty"`
	User string   `json:"user,omitempty"`
	// Restart is "always", "on-failure" or "never".
	Restart string `json:"restart,omitempty"`
	// Source is "api" for a file services.add wrote, else "image".
	Source string `json:"source,omitempty"`
}

type ServiceStatus struct {
	Name     string `json:"name"`
	State    string `json:"state"` // starting, running, backoff, stopped, exited
	Pid      int    `json:"pid,omitempty"`
	Restarts int    `json:"restarts"`
	LastExit *Exit  `json:"last_exit,omitempty"`
	// Def is the definition the service runs, as read from its file.
	Def ServiceDef `json:"def"`
	// Root is whether the service runs as uid 0, or as a user the guest
	// cannot resolve.
	Root bool `json:"root"`
}

type ServicesList struct {
	Services []ServiceStatus `json:"services"`
	// ImageUser is the image's user, which a service without one runs as.
	ImageUser string `json:"image_user"`
}

type Started struct {
	Pid int `json:"pid"`
	// Session and Created are set on a session connection; Created is false
	// when the connection attached to a session that already ran.
	Session string `json:"session,omitempty"`
	Created bool   `json:"created,omitempty"`
	// KillGraceMs echoes a non-tty exec's kill_grace_ms (as clamped), so the
	// host knows this agent will kill a stopped command's group; older ones
	// omit it.
	KillGraceMs int64 `json:"kill_grace_ms,omitempty"`
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
