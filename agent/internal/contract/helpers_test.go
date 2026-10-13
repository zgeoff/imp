package contract

import (
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

	"gotest.tools/v3/assert"
)

// coverage records, per struct type, the fields that hold a value in at
// least one of the values added.
type coverage map[reflect.Type]map[int]bool

func (c coverage) add(value any) {
	c.walk(reflect.ValueOf(value))
}

func (c coverage) walk(v reflect.Value) {
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
		set := c[v.Type()]
		if set == nil {
			set = map[int]bool{}
			c[v.Type()] = set
		}
		for i := range v.NumField() {
			if !v.Field(i).IsZero() {
				set[i] = true
			}
			c.walk(v.Field(i))
		}
	}
}

// unset lists, as Type.Field, the fields of the types seen that no value set.
func (c coverage) unset(except ...string) []string {
	var out []string
	for typ, set := range c {
		for i := range typ.NumField() {
			name := typ.Name() + "." + typ.Field(i).Name
			if !set[i] && !slices.Contains(except, name) {
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

// decodeStrict decodes a fixture into v, refusing a field v does not have.
func decodeStrict(t *testing.T, path string, v any) error {
	t.Helper()
	b, err := os.ReadFile(path)
	assert.NilError(t, err)
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
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

func TestDecodeStrictRefusesAFieldTheTypeLacks(t *testing.T) {
	path := t.TempDir() + "/fixture.json"
	assert.NilError(t, os.WriteFile(path, []byte(`{"A":"a","D":1}`), 0o644))

	err := decodeStrict(t, path, &covered{})

	assert.ErrorContains(t, err, `unknown field "D"`)
}
