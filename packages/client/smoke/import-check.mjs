// The packed client imported under plain Node, from a project that installed
// its tarball (scripts/release/check-client-package.sh): no Bun, no
// workspace. Argument: the version the package must report.
import assert from 'node:assert/strict';
import * as client from '@zgeoff/imp-client';

const imp = client.createImpClient({ url: 'http://impd.test/', token: 't' });

assert.equal(client.CLIENT_VERSION, process.argv[2]);
assert.equal(typeof imp.imps.create, 'function');
assert.equal(typeof imp.requireAwake, 'function');
assert.equal(typeof imp.openExec, 'function');
assert.equal(typeof client.ExecError, 'function');
assert.equal(typeof client.isDefinedError, 'function');

console.log(`imported @zgeoff/imp-client ${client.CLIENT_VERSION}`);
