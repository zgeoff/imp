package contract

import (
	"bytes"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/reflect/protoreflect"
	"gotest.tools/v3/assert"

	"github.com/zgeoff/imp/agent/internal/proto"
)

// coverage records, per type, which fields hold a value in at least one of
// the values added. A Go struct's field holds one when it is not zero; a
// message's when the message has it, so an optional field set to zero
// counts and an implicit one at zero does not.
type coverage map[string]map[string]bool

func (c coverage) add(value any) {
	c.walk(reflect.ValueOf(value))
}

func (c coverage) walk(v reflect.Value) {
	if v.Kind() == reflect.Pointer && !v.IsNil() {
		if m, ok := v.Interface().(protoreflect.ProtoMessage); ok {
			c.walkMessage(m.ProtoReflect())
			return
		}
	}
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if !v.IsNil() {
			c.walk(v.Elem())
		}
	case reflect.Slice:
		for i := range v.Len() {
			c.walk(v.Index(i))
		}
	case reflect.Struct:
		set := c.fields(v.Type().Name())
		for i := range v.NumField() {
			name := v.Type().Field(i).Name
			set[name] = set[name] || !v.Field(i).IsZero()
			c.walk(v.Field(i))
		}
	}
}

func (c coverage) walkMessage(m protoreflect.Message) {
	desc := m.Descriptor()
	set := c.fields(string(desc.Name()))
	for i := range desc.Fields().Len() {
		field := desc.Fields().Get(i)
		name := string(field.Name())
		set[name] = set[name] || m.Has(field)
	}
	m.Range(func(field protoreflect.FieldDescriptor, v protoreflect.Value) bool {
		switch {
		case field.IsList() && field.Message() != nil:
			for i := range v.List().Len() {
				c.walkMessage(v.List().Get(i).Message())
			}
		case field.Message() != nil && !field.IsMap():
			c.walkMessage(v.Message())
		}
		return true
	})
}

func (c coverage) fields(typ string) map[string]bool {
	if c[typ] == nil {
		c[typ] = map[string]bool{}
	}
	return c[typ]
}

// unset lists, as Type.field, the fields of the types seen that no value set.
func (c coverage) unset(except ...string) []string {
	var out []string
	for typ, set := range c {
		for field, ok := range set {
			name := typ + "." + field
			if !ok && !slices.Contains(except, name) {
				out = append(out, name)
			}
		}
	}
	slices.Sort(out)
	return out
}

// declaredConsts reads the constants of a source file whose names start
// with prefix and whose values are a literal: a string or an int.
func declaredConsts(t *testing.T, path, prefix string) map[string]any {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
	assert.NilError(t, err)
	consts := map[string]any{}
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST {
			continue
		}
		for _, spec := range gen.Specs {
			value := spec.(*ast.ValueSpec)
			for i, name := range value.Names {
				if !strings.HasPrefix(name.Name, prefix) || i >= len(value.Values) {
					continue
				}
				lit, ok := value.Values[i].(*ast.BasicLit)
				if !ok {
					continue
				}
				switch lit.Kind {
				case token.STRING:
					s, err := strconv.Unquote(lit.Value)
					assert.NilError(t, err)
					consts[name.Name] = s
				case token.INT:
					n, err := strconv.Atoi(lit.Value)
					assert.NilError(t, err)
					consts[name.Name] = n
				}
			}
		}
	}
	return consts
}

// decodeJSON reads a fixture's JSON as plain values, to compare two whatever
// their layout.
func decodeJSON(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	assert.NilError(t, json.Unmarshal(b, &v))
	return v
}

// encodeFixture is a fixture file's JSON, indented: a message as the
// agent's own writer sends it, any other value as encoding/json writes it.
func encodeFixture(t *testing.T, value any) []byte {
	t.Helper()
	m, ok := value.(protoreflect.ProtoMessage)
	if !ok {
		b, err := json.MarshalIndent(value, "", "  ")
		assert.NilError(t, err)
		return append(b, '\n')
	}
	b, err := proto.Marshal(m)
	assert.NilError(t, err)
	var out bytes.Buffer
	assert.NilError(t, json.Indent(&out, b, "", "  "))
	return append(out.Bytes(), '\n')
}

// decodeStrict decodes a fixture into v, refusing a field v does not have.
func decodeStrict(t *testing.T, path string, v any) error {
	t.Helper()
	b, err := os.ReadFile(path)
	assert.NilError(t, err)
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

// decodeMessage decodes a fixture into m, refusing a field the schema does
// not have; the agent itself ignores one.
func decodeMessage(t *testing.T, path string, m protoreflect.ProtoMessage) error {
	t.Helper()
	b, err := os.ReadFile(path)
	assert.NilError(t, err)
	return protojson.Unmarshal(b, m)
}

type covered struct {
	A string
	B *int
	C []covered
}

func TestCoverageListsTheFieldsNoValueSets(t *testing.T) {
	c := coverage{}
	c.add(covered{A: "a", C: []covered{{A: "b"}}})

	assert.DeepEqual(t, c.unset(), []string{"covered.B"})
}

func TestCoverageCountsAFieldSetInAnyOfTheValues(t *testing.T) {
	n := 1
	c := coverage{}
	c.add(covered{A: "a"})
	c.add(&covered{B: &n, C: []covered{{A: "b", B: &n, C: []covered{}}}})

	assert.DeepEqual(t, c.unset(), []string(nil))
}

func TestCoverageLeavesOutTheFieldsExcepted(t *testing.T) {
	c := coverage{}
	c.add(covered{A: "a"})

	assert.DeepEqual(t, c.unset("covered.B"), []string{"covered.C"})
}

func TestCoverageListsTheFieldsOfAMessageNoValueHas(t *testing.T) {
	c := coverage{}
	c.add(&proto.Previous{ExecutionGeneration: "g", Exit: &proto.Exit{Code: 1}})

	assert.DeepEqual(t, c.unset(), []string{"Exit.signal", "Previous.end"})
}

func TestCoverageCountsAnOptionalFieldSetToZero(t *testing.T) {
	c := coverage{}
	c.add(&proto.Listening{Ok: true, Path: new(""), Port: new(uint32(0)), Listener: "l1"})

	assert.DeepEqual(t, c.unset(), []string(nil))
}

func TestCoverageWalksTheMessagesOfAList(t *testing.T) {
	c := coverage{}
	c.add(&proto.ServicesList{ImageUser: "dev", Services: []*proto.ServiceStatus{{Name: "web"}}})

	assert.DeepEqual(t, c.unset(), []string{
		"ServiceStatus.def", "ServiceStatus.last_exit", "ServiceStatus.pid",
		"ServiceStatus.restarts", "ServiceStatus.root", "ServiceStatus.state",
	})
}

func TestDeclaredConstsReadsTheLiteralsOfAPrefix(t *testing.T) {
	path := t.TempDir() + "/consts.go"
	assert.NilError(t, os.WriteFile(path, []byte(`package x
const (
	ErrA = "A"
	ErrB = "B"
	TypeOne Type = 1
	Other = "other"
	ErrComputed = ErrA + "x"
)
`), 0o644))

	assert.DeepEqual(t, declaredConsts(t, path, "Err"), map[string]any{"ErrA": "A", "ErrB": "B"})
	assert.DeepEqual(t, declaredConsts(t, path, "Type"), map[string]any{"TypeOne": 1})
}

func TestDecodeJSONReadsTwoLayoutsOfOneValueAlike(t *testing.T) {
	compact := decodeJSON(t, []byte(`{"argv":["make","-j4"]}`))
	indented := decodeJSON(t, []byte("{\n  \"argv\": [\n    \"make\",\n    \"-j4\"\n  ]\n}\n"))

	assert.DeepEqual(t, compact, indented)
}

func TestEncodeFixtureWritesAMessageUnderItsProtoNamesWithItsZeros(t *testing.T) {
	got := encodeFixture(t, &proto.Previous{ExecutionGeneration: "g", Exit: &proto.Exit{Code: 1}})

	assert.Equal(t, string(got), `{
  "execution_generation": "g",
  "end": 0,
  "exit": {
    "code": 1,
    "signal": 0
  }
}
`)
}

func TestEncodeFixtureWritesAPlainValueAsJSON(t *testing.T) {
	got := encodeFixture(t, map[string]any{"total_record": "IMP.total"})

	assert.Equal(t, string(got), "{\n  \"total_record\": \"IMP.total\"\n}\n")
}

func TestDecodeStrictRefusesAFieldTheTypeLacks(t *testing.T) {
	path := t.TempDir() + "/fixture.json"
	assert.NilError(t, os.WriteFile(path, []byte(`{"A":"a","D":1}`), 0o644))

	err := decodeStrict(t, path, &covered{})

	assert.ErrorContains(t, err, `unknown field "D"`)
}

func TestDecodeMessageRefusesAFieldTheSchemaLacks(t *testing.T) {
	path := t.TempDir() + "/fixture.json"
	assert.NilError(t, os.WriteFile(path, []byte(`{"cols":120,"rows":40,"depth":1}`), 0o644))

	err := decodeMessage(t, path, &proto.Resize{})

	assert.ErrorContains(t, err, `unknown field "depth"`)
}
