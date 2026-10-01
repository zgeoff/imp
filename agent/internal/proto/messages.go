package proto

// Version is the agent protocol version reported by ping.
const Version = "0.1.0"

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

	// freeze: auto-thaw after this many ms (default 30000)
	TimeoutMs int64 `json:"timeout_ms,omitempty"`

	// resumed
	UnixMs int64 `json:"unix_ms,omitempty"`
}

// Error codes.
const (
	ErrBadRequest = "BAD_REQUEST"
	ErrUnknownOp  = "UNKNOWN_OP"
	ErrExecFailed = "EXEC_FAILED"
	ErrInternal   = "INTERNAL"
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
	OK       bool   `json:"ok"`
	Version  string `json:"version"`
	UptimeMs int64  `json:"uptime_ms"`
}

type OK struct {
	OK bool `json:"ok"`
}

type Activity struct {
	TCPEstablished int     `json:"tcp_established"`
	ExecSessions   int     `json:"exec_sessions"`
	Load1          float64 `json:"load1"`
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
}

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
