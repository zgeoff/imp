// Package cmdline parses the kernel command line for imp.* parameters.
package cmdline

import (
	"encoding/json"
	"os"
	"strings"
)

// Params holds the imp.* parameters the host passes on the kernel cmdline.
type Params struct {
	Hostname string
	// IP is the guest address in CIDR form, e.g. 10.66.0.2/30.
	IP string
	GW string
	// IP6 is the guest's IPv6 /128 and GW6 its link-local gateway; both
	// empty when the host gives imps no IPv6.
	IP6 string
	GW6 string
	DNS []string
	// ResetIdentity is set on the first boot of an imp made from a template.
	ResetIdentity bool
	// Template is set on the cold boot that makes a boot template: stage 1
	// waits for a claim instead of mounting the user disk.
	Template bool
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
		case "reset_identity":
			p.ResetIdentity = val == "1"
		case "ip6":
			p.IP6 = val
		case "gw6":
			p.GW6 = val
		case "template":
			p.Template = val == "1"
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

// Encode is how stage 1 hands the parameters to stage 2, as one argv entry:
// after a template restore the kernel cmdline is the template's, so stage 2
// never reads it (docs/architecture/boot-templates.md#claim).
func (p Params) Encode() string {
	b, err := json.Marshal(p)
	if err != nil {
		// a struct of strings always marshals
		panic(err)
	}
	return string(b)
}

// Decode reads what Encode wrote.
func Decode(s string) (Params, error) {
	var p Params
	err := json.Unmarshal([]byte(s), &p)
	return p, err
}
