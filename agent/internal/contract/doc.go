// Package contract pins the agent's host-facing contracts to the JSON
// fixtures in testdata, which impd's tests read too
// (packages/daemon/src/agent-client/agent-protocol.test.ts). It holds only
// tests: testdata/guest is what the agent sends impd, written by these tests
// with -write; testdata/host is what impd sends the agent, which these tests
// check the agent takes. A field added on one side alone fails one of them.
package contract
