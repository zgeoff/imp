// Command imp-agentctl is a dev-only host-side client for the imp agent. It
// talks to the agent through Firecracker's vsock unix socket.
//
//	imp-agentctl -sock run/vsock.sock ping [-wait 10s]
//	imp-agentctl -sock run/vsock.sock activity
//	imp-agentctl -sock run/vsock.sock exec [-t] -- cmd args...
//	imp-agentctl -sock run/vsock.sock resumed   (sends the host clock)
//
// Any other op name is sent as a bare unary request, e.g. "freeze".
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	"github.com/zgeoff/imp/agent/internal/proto"
)

const agentPort = 1024

func main() {
	sock := flag.String("sock", "", "Firecracker vsock unix socket")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: imp-agentctl -sock PATH {ping [-wait D] | activity | exec [-t] -- ARGV... | resumed | OP}")
		flag.PrintDefaults()
	}
	flag.Parse()
	if *sock == "" || flag.NArg() == 0 {
		flag.Usage()
		os.Exit(2)
	}
	op, args := flag.Arg(0), flag.Args()[1:]

	var err error
	code := 0
	switch op {
	case "ping":
		err = ping(*sock, args)
	case "exec":
		code, err = execCmd(*sock, args)
	case proto.OpResumed:
		err = unary(*sock, proto.Request{Op: op, UnixMs: time.Now().UnixMilli()})
	default:
		err = unary(*sock, proto.Request{Op: op})
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "imp-agentctl:", err)
		os.Exit(1)
	}
	os.Exit(code)
}

// dial connects to the guest agent through Firecracker's vsock proxy.
func dial(sock string) (net.Conn, *bufio.Reader, error) {
	c, err := net.Dial("unix", sock)
	if err != nil {
		return nil, nil, err
	}
	fail := func(err error) (net.Conn, *bufio.Reader, error) {
		c.Close()
		return nil, nil, err
	}
	if _, err := fmt.Fprintf(c, "CONNECT %d\n", agentPort); err != nil {
		return fail(err)
	}
	br := bufio.NewReader(c)
	line, err := br.ReadString('\n')
	if err != nil {
		return fail(fmt.Errorf("vsock handshake: %w", err))
	}
	if !strings.HasPrefix(line, "OK ") {
		return fail(fmt.Errorf("vsock handshake: %q", strings.TrimSpace(line)))
	}
	return c, br, nil
}

// roundTrip sends one unary request and returns the RESPONSE payload.
func roundTrip(sock string, req proto.Request) (json.RawMessage, error) {
	c, br, err := dial(sock)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	if err := proto.NewWriter(c).WriteJSON(proto.TypeRequest, req); err != nil {
		return nil, err
	}
	f, err := proto.NewReader(br).Next()
	if err != nil {
		return nil, err
	}
	if f.Type != proto.TypeResponse {
		return nil, fmt.Errorf("unexpected %s frame", f.Type)
	}
	var e proto.ErrorResponse
	if json.Unmarshal(f.Payload, &e) == nil && e.Error != nil {
		return nil, e.Error
	}
	return f.Payload, nil
}

func unary(sock string, req proto.Request) error {
	resp, err := roundTrip(sock, req)
	if err != nil {
		return err
	}
	fmt.Println(string(resp))
	return nil
}

// ping retries until the agent answers or -wait runs out, which makes it a
// boot-readiness probe.
func ping(sock string, args []string) error {
	fs := flag.NewFlagSet("ping", flag.ExitOnError)
	wait := fs.Duration("wait", 0, "retry until the agent answers or this much time passes")
	fs.Parse(args)

	start := time.Now()
	for {
		resp, err := roundTrip(sock, proto.Request{Op: proto.OpPing})
		if err == nil {
			fmt.Printf("%s waited_ms=%d\n", resp, time.Since(start).Milliseconds())
			return nil
		}
		var pe *proto.Error
		if errors.As(err, &pe) || time.Since(start) >= *wait {
			return err
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func execCmd(sock string, args []string) (int, error) {
	fs := flag.NewFlagSet("exec", flag.ExitOnError)
	tty := fs.Bool("t", false, "allocate a pty (puts the local terminal in raw mode)")
	user := fs.String("u", "", "run as user")
	cwd := fs.String("C", "", "working directory")
	fs.Parse(args)
	if fs.NArg() == 0 {
		return 2, errors.New("exec: missing command")
	}

	req := proto.Request{Op: proto.OpExec, Argv: fs.Args(), TTY: *tty, User: *user, Cwd: *cwd}
	stdinFd := int(os.Stdin.Fd())
	if *tty && term.IsTerminal(stdinFd) {
		if cols, rows, err := term.GetSize(stdinFd); err == nil {
			req.Cols, req.Rows = uint16(cols), uint16(rows)
		}
		if t := os.Getenv("TERM"); t != "" {
			req.Env = append(req.Env, "TERM="+t)
		}
		old, err := term.MakeRaw(stdinFd)
		if err != nil {
			return 1, err
		}
		defer term.Restore(stdinFd, old)
	}

	c, br, err := dial(sock)
	if err != nil {
		return 1, err
	}
	defer c.Close()
	w, r := proto.NewWriter(c), proto.NewReader(br)
	if err := w.WriteJSON(proto.TypeRequest, req); err != nil {
		return 1, err
	}

	go sendStdin(w)
	if *tty {
		go forwardResize(w, stdinFd)
	} else {
		go forwardSignals(w)
	}

	for {
		f, err := r.Next()
		if err != nil {
			return 1, fmt.Errorf("connection closed before exit: %w", err)
		}
		switch f.Type {
		case proto.TypeStarted:
		case proto.TypeStdout:
			os.Stdout.Write(f.Payload)
		case proto.TypeStderr:
			os.Stderr.Write(f.Payload)
		case proto.TypeExit:
			var e proto.Exit
			if err := json.Unmarshal(f.Payload, &e); err != nil {
				return 1, err
			}
			return e.Code, nil
		case proto.TypeResponse:
			var e proto.ErrorResponse
			if json.Unmarshal(f.Payload, &e) == nil && e.Error != nil {
				return 1, e.Error
			}
			return 1, fmt.Errorf("unexpected response: %s", f.Payload)
		}
	}
}

func sendStdin(w *proto.Writer) {
	buf := make([]byte, 32<<10)
	for {
		n, err := os.Stdin.Read(buf)
		if n > 0 && w.Write(proto.TypeStdin, buf[:n]) != nil {
			return
		}
		if err == io.EOF {
			w.Write(proto.TypeStdinEOF, nil)
			return
		}
		if err != nil {
			return
		}
	}
}

func forwardResize(w *proto.Writer, fd int) {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGWINCH)
	for range ch {
		if cols, rows, err := term.GetSize(fd); err == nil {
			w.WriteJSON(proto.TypeResize, proto.Resize{Cols: uint16(cols), Rows: uint16(rows)})
		}
	}
}

// forwardSignals relays Ctrl-C and friends to the remote process group.
func forwardSignals(w *proto.Writer) {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGQUIT)
	for s := range ch {
		w.WriteJSON(proto.TypeSignal, proto.Signal{Signal: int(s.(syscall.Signal))})
	}
}
