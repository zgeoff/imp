package contract

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"google.golang.org/protobuf/reflect/protoreflect"
	"gotest.tools/v3/assert"

	"github.com/zgeoff/impz/agent/internal/cmdline"
	"github.com/zgeoff/impz/agent/internal/fsroot"
	"github.com/zgeoff/impz/agent/internal/imagecfg"
	"github.com/zgeoff/impz/agent/internal/proto"
	"github.com/zgeoff/impz/agent/internal/services"
	"github.com/zgeoff/impz/agent/internal/tartool"
)

// testdata/host is impd's side, kept by hand: impd's tests check that it
// builds each of these, and these tests that the agent takes each whole.

func TestTheAgentDecodesEveryHostRequestWithNoFieldLeftOver(t *testing.T) {
	entries, err := os.ReadDir(filepath.Join("testdata", "host", "requests"))
	assert.NilError(t, err)

	for _, entry := range entries {
		t.Run(entry.Name(), func(t *testing.T) {
			var req proto.Request

			err := decodeMessage(t, filepath.Join("testdata", "host", "requests", entry.Name()), &req)

			assert.NilError(t, err)
			assert.Equal(t, req.Op, strings.TrimSuffix(entry.Name(), ".json"))
		})
	}
}

func TestHostRequestsCoverEveryOp(t *testing.T) {
	entries, err := os.ReadDir(filepath.Join("testdata", "host", "requests"))
	assert.NilError(t, err)
	var files []string
	for _, entry := range entries {
		files = append(files, strings.TrimSuffix(entry.Name(), ".json"))
	}
	var ops []string
	for _, op := range declaredConsts(t, "../proto/messages.go", "Op") {
		ops = append(ops, op.(string))
	}
	slices.Sort(ops)

	assert.DeepEqual(t, files, ops)
}

func TestHostRequestsSetEveryFieldOfARequest(t *testing.T) {
	entries, err := os.ReadDir(filepath.Join("testdata", "host", "requests"))
	assert.NilError(t, err)
	c := coverage{}
	for _, entry := range entries {
		req := &proto.Request{}
		assert.NilError(t, decodeMessage(t, filepath.Join("testdata", "host", "requests", entry.Name()), req))
		c.add(req)
	}

	// the agent marks where a service came from; impd never says
	assert.DeepEqual(t, c.unset("ServiceDef.source"), []string(nil))
}

func TestTheAgentDecodesTheHostFramesWithNoFieldLeftOver(t *testing.T) {
	for _, tc := range []struct {
		file  string
		value protoreflect.ProtoMessage
	}{
		{file: "resize.json", value: &proto.Resize{}},
		{file: "signal.json", value: &proto.Signal{}},
	} {
		t.Run(tc.file, func(t *testing.T) {
			err := decodeMessage(t, filepath.Join("testdata", "host", tc.file), tc.value)

			assert.NilError(t, err)
			c := coverage{}
			c.add(tc.value)
			assert.DeepEqual(t, c.unset(), []string(nil))
		})
	}
}

// cmdlineFixture is impd's kernel cmdline for an imp with every option on,
// and for a boot template.
type cmdlineFixture struct {
	BootArgs         string `json:"boot_args"`
	TemplateBootArgs string `json:"template_boot_args"`
}

// cmdlineKeys are the imp.* keys the agent reads; imp.id is impd's own, for
// a reader of the guest's /proc/cmdline, and the agent leaves it alone.
var cmdlineKeys = []string{"dns", "gw", "gw6", "hostname", "id", "ip", "ip6", "reset_identity", "template"}

func TestTheAgentReadsEveryKeyOfTheHostCmdline(t *testing.T) {
	var fixture cmdlineFixture
	assert.NilError(t, decodeStrict(t, filepath.Join("testdata", "host", "cmdline.json"), &fixture))
	var unknown []string
	c := coverage{}

	for _, line := range []string{fixture.BootArgs, fixture.TemplateBootArgs} {
		params := cmdline.Parse(line)
		c.add(params)
		for key := range params.Raw {
			if !slices.Contains(cmdlineKeys, key) {
				unknown = append(unknown, key)
			}
		}
	}

	assert.DeepEqual(t, unknown, []string(nil))
	assert.DeepEqual(t, c.unset(), []string(nil))
}

func TestTheAgentReadsTheHostImageConfigWithNoFieldLeftOver(t *testing.T) {
	var cfg imagecfg.Config

	err := decodeStrict(t, filepath.Join("testdata", "host", "image.json"), &cfg)

	assert.NilError(t, err)
	c := coverage{}
	c.add(cfg)
	assert.DeepEqual(t, c.unset(), []string(nil))
}

// tarFixture is the argv impd gives `imp-agent tar`, after "tar".
type tarFixture struct {
	Create       []string `json:"create"`
	Extract      []string `json:"extract"`
	ExtractOwner []string `json:"extract_owner"`
}

func TestTheTarToolTakesEachArgvTheHostSends(t *testing.T) {
	var fixture tarFixture
	assert.NilError(t, decodeStrict(t, filepath.Join("testdata", "host", "tar.json"), &fixture))
	var got []tartool.Command

	for _, args := range [][]string{fixture.Create, fixture.Extract, fixture.ExtractOwner} {
		cmd, err := tartool.ParseArgs(args)
		assert.NilError(t, err)
		got = append(got, cmd)
	}

	assert.DeepEqual(t, got, []tartool.Command{
		{Op: "create", Path: fixture.Create[1]},
		{Op: "extract", Path: fixture.Extract[1]},
		{Op: "extract", Path: fixture.ExtractOwner[3], Owner: fixture.ExtractOwner[2]},
	})
}

func TestTheAgentReadsAnImagesServicesFile(t *testing.T) {
	path := filepath.Join("testdata", "host", "services-d.json")
	assert.NilError(t, decodeMessage(t, path, &proto.ServiceDef{}))

	def, err := services.ReadDef(fsroot.Host, path)

	assert.NilError(t, err)
	c := coverage{}
	c.add(def)
	assert.DeepEqual(t, c.unset(), []string(nil))
	assert.Equal(t, def.GetSource(), "image")
}
