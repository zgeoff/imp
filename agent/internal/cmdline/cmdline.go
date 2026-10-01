// Package cmdline parses the kernel command line for imp.* parameters.
package cmdline

import (
	"os"
	"strings"
)

// Params holds the imp.* parameters the host passes on the kernel cmdline.
type Params struct {
	Hostname string
	// IP is the guest address in CIDR form, e.g. 10.66.0.2/30.
	IP  string
	GW  string
	DNS []string
	// Raw holds every imp.* key (without the prefix), including unknown ones.
	Raw map[string]string
}

// Read parses /proc/cmdline.
func Read() (Params, error) {
	b, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		return Params{}, err
	}
	return Parse(string(b)), nil
}

// Parse extracts imp.* parameters from a kernel command line. Values may be
// double-quoted, as the kernel allows: imp.x="a b".
func Parse(line string) Params {
	p := Params{Raw: make(map[string]string)}
	for _, field := range split(line) {
		key, val, _ := strings.Cut(field, "=")
		name, ok := strings.CutPrefix(key, "imp.")
		if !ok {
			continue
		}
		val = strings.Trim(val, `"`)
		p.Raw[name] = val
		switch name {
		case "hostname":
			p.Hostname = val
		case "ip":
			p.IP = val
		case "gw":
			p.GW = val
		case "dns":
			for _, s := range strings.Split(val, ",") {
				if s = strings.TrimSpace(s); s != "" {
					p.DNS = append(p.DNS, s)
				}
			}
		}
	}
	return p
}

// split breaks a command line on whitespace outside double quotes.
func split(line string) []string {
	var out []string
	var cur strings.Builder
	quoted := false
	for _, r := range line {
		switch {
		case r == '"':
			quoted = !quoted
			cur.WriteRune(r)
		case !quoted && (r == ' ' || r == '\t' || r == '\n'):
			if cur.Len() > 0 {
				out = append(out, cur.String())
				cur.Reset()
			}
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}
