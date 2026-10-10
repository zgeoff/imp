import { expect, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { buildMockImpRecord } from './build-mock-imp-record';
import { buildStubSshBackend } from './build-stub-ssh-backend';

test('it finds an imp it holds by name', async () => {
  const ssh = buildStubSshBackend();
  const imp = buildMockImpRecord();

  ssh.putImp(imp);

  const found = await ssh.backend.findImp(imp.name);

  expect(found).toBe(imp);
});

test('it finds no imp it does not hold', async () => {
  const ssh = buildStubSshBackend();

  const found = await ssh.backend.findImp('nobody');

  expect(found).toBeUndefined();
});

test('it counts each imp lookup', async () => {
  const ssh = buildStubSshBackend();

  await ssh.backend.findImp('one');
  await ssh.backend.findImp('two');

  expect(ssh.stub.lookups).toBe(2);
});

test('it rejects a lookup with the find error a test sets', () => {
  const ssh = buildStubSshBackend();

  ssh.stub.findError = new Error('database is locked');

  expect(ssh.backend.findImp('box')).rejects.toThrowWithMessage(Error, 'database is locked');
});

test('it answers a wake with the imp as it holds it, already running', async () => {
  const ssh = buildStubSshBackend();
  const imp = buildMockImpRecord();

  ssh.putImp(imp);

  const running = await ssh.backend.requireRunning(imp.name);

  expect(running).toStrictEqual({ imp, wokeMs: null });
});

test('it answers a wake with the wake time a test sets', async () => {
  const ssh = buildStubSshBackend();
  const imp = buildMockImpRecord();

  ssh.putImp(imp);

  ssh.stub.wokeMs = 840;

  const running = await ssh.backend.requireRunning(imp.name);

  expect(running).toStrictEqual({ imp, wokeMs: 840 });
});

// a put with a new pid stands for a wake into a new VM
test('it answers a wake with the imp put last under its name', async () => {
  const ssh = buildStubSshBackend();
  const imp = buildMockImpRecord({ pid: 100 });

  ssh.putImp(imp);
  ssh.putImp({ ...imp, pid: 101 });

  const running = await ssh.backend.requireRunning(imp.name);

  expect(running.imp.pid).toBe(101);
});

test('it rejects a wake of an imp it does not hold as NOT_FOUND', () => {
  const ssh = buildStubSshBackend();

  expect(ssh.backend.requireRunning('nobody')).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('it rejects a wake with the wake error a test sets, and counts it', () => {
  const ssh = buildStubSshBackend();

  ssh.stub.wakeError = new Error('no room');

  expect(ssh.backend.requireRunning('box')).rejects.toThrowWithMessage(Error, 'no room');
  expect(ssh.stub.wakes).toBe(1);
});

test('it records each imp whose activity the gateway records', async () => {
  const ssh = buildStubSshBackend();

  await ssh.backend.recordActivity('box');
  await ssh.backend.recordActivity('dev');

  expect(ssh.activity).toStrictEqual(['box', 'dev']);
});

test('it records an exec’s request, stdin, resizes and signals', async () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  const stream = await ssh.backend.openExec(
    'box',
    { argv: ['/bin/sh', '-c', 'cat'], tty: false },
    undefined,
    { kind: 'ssh', name: 'ci' },
  );

  stream.writeStdin(new TextEncoder().encode('input'));
  stream.closeStdin();
  stream.resize(80, 24);
  stream.sendSignal(2);

  expect(ssh.execs).toStrictEqual([
    {
      request: { argv: ['/bin/sh', '-c', 'cat'], tty: false },
      feature: undefined,
      stdin: ['input', '<eof>'],
      resizes: ['80x24'],
      signals: [2],
      emit: expect.toBeFunction(),
    },
  ]);
});

test('it records who each exec ran as', async () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  await ssh.backend.openExec('box', { argv: ['true'], tty: false }, undefined, {
    kind: 'ssh',
    name: 'ci',
  });

  expect(ssh.actors).toStrictEqual([{ kind: 'ssh', name: 'ci' }]);
});

test('it yields the events a test emits on an exec, until null', async () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  ssh.stub.onExec = (run) => {
    run.emit({ type: 'stdout', data: new TextEncoder().encode('hi') });
    run.emit({ type: 'exit', code: 0, signal: 0 });
    run.emit(null);
  };

  const stream = await ssh.backend.openExec('box', { argv: ['true'], tty: false }, undefined, {
    kind: 'ssh',
    name: 'ci',
  });

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('hi') },
    { type: 'exit', code: 0, signal: 0 },
  ]);
});

test('it holds an exec’s stdin drain until the gate a test sets opens', async () => {
  const ssh = buildStubSshBackend();
  const gate = Promise.withResolvers<void>();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  ssh.stub.stdinGate = gate.promise;

  const stream = await ssh.backend.openExec('box', { argv: ['cat'], tty: false }, undefined, {
    kind: 'ssh',
    name: 'ci',
  });

  const drain = stream.stdinDrained();
  const statusBefore = Bun.peek.status(drain);

  gate.resolve();

  await drain;

  expect(statusBefore).toBe('pending');
  expect(Bun.peek.status(drain)).toBe('fulfilled');
});

test('it counts an open exec on the tracker as an exec until it closes', async () => {
  const ssh = buildStubSshBackend();
  const imp = buildMockImpRecord({ name: 'box' });

  ssh.putImp(imp);

  const stream = await ssh.backend.openExec('box', { argv: ['true'], tty: false }, undefined, {
    kind: 'ssh',
    name: 'ci',
  });

  const countWhileOpen = ssh.tracker.count(imp.id, 'exec');

  stream.close();

  expect(countWhileOpen).toBe(1);
  expect(ssh.tracker.count(imp.id)).toBe(0);
});

test('it rejects an exec on an imp it does not hold as NOT_FOUND', () => {
  const ssh = buildStubSshBackend();

  const exec = ssh.backend.openExec('nobody', { argv: ['true'], tty: false }, undefined, {
    kind: 'ssh',
    name: 'ci',
  });

  expect(exec).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('it rejects an exec with the exec error a test sets, and counts nothing', () => {
  const ssh = buildStubSshBackend();
  const imp = buildMockImpRecord({ name: 'box' });

  ssh.putImp(imp);

  ssh.stub.execError = new Error('agent outdated');

  const exec = ssh.backend.openExec('box', { argv: ['true'], tty: false }, undefined, {
    kind: 'ssh',
    name: 'ci',
  });

  expect(exec).rejects.toThrowWithMessage(Error, 'agent outdated');
  expect(ssh.tracker.count(imp.id)).toBe(0);
});

// as an HTTP server answers a whole request
test('it answers a dial with got and its input once the client half-closes', async () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  const dial = await ssh.backend.openDial(
    'box',
    { network: 'tcp', address: '127.0.0.1:80' },
    'ssh',
  );

  dial.write(new TextEncoder().encode('request'));
  dial.end();

  const events = await Array.fromAsync(dial.events());

  expect(events).toStrictEqual([
    { type: 'data', data: new TextEncoder().encode('got request') },
    { type: 'eof' },
  ]);
});

test('it records each dial’s target, kind and input', async () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  const dial = await ssh.backend.openDial(
    'box',
    { network: 'unix', address: '/run/app.sock' },
    'tunnel',
  );

  dial.write(new TextEncoder().encode('ping'));

  expect(ssh.dials).toStrictEqual([
    { target: { network: 'unix', address: '/run/app.sock' }, kind: 'tunnel', input: ['ping'] },
  ]);
});

test('it counts an open dial on the tracker under its kind until it closes', async () => {
  const ssh = buildStubSshBackend();
  const imp = buildMockImpRecord({ name: 'box' });

  ssh.putImp(imp);

  const dial = await ssh.backend.openDial(
    'box',
    { network: 'tcp', address: '127.0.0.1:80' },
    'ssh',
  );

  const countWhileOpen = ssh.tracker.count(imp.id, 'ssh');

  dial.close();

  expect(countWhileOpen).toBe(1);
  expect(ssh.tracker.count(imp.id)).toBe(0);
});

test('it rejects a dial with the dial error a test sets', () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  ssh.stub.dialError = new Error('connection refused');

  const dial = ssh.backend.openDial('box', { network: 'tcp', address: '127.0.0.1:9' }, 'ssh');

  expect(dial).rejects.toThrowWithMessage(Error, 'connection refused');
});

test('it puts an ssh-agent listener’s socket under /run/imp/ssh-agent', async () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  const listener = await ssh.backend.openListener('box', { network: 'ssh-agent' }, 'ssh');

  expect(listener).toStrictEqual({
    id: 'stub1',
    path: '/run/imp/ssh-agent/stub1/agent.sock',
    port: null,
    connections: expect.toBeFunction(),
    close: expect.toBeFunction(),
  });
});

test('it puts a unix listener’s socket at the path asked for', async () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  const listener = await ssh.backend.openListener(
    'box',
    { network: 'unix', path: '/home/dev/app.sock' },
    null,
  );

  expect(listener).toStrictEqual({
    id: 'stub1',
    path: '/home/dev/app.sock',
    port: null,
    connections: expect.toBeFunction(),
    close: expect.toBeFunction(),
  });
});

test('it puts a unix listener with no path under /run/imp/forward', async () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  const listener = await ssh.backend.openListener('box', { network: 'unix', path: null }, null);

  expect(listener.path).toBe('/run/imp/forward/stub1/sock');
});

test('it picks 40000 plus the listener count for a TCP listener asked for port 0', async () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  await ssh.backend.openListener('box', { network: 'ssh-agent' }, 'ssh');

  const listener = await ssh.backend.openListener('box', { network: 'tcp', port: 0 }, null);

  expect(listener).toStrictEqual({
    id: 'stub2',
    path: null,
    port: 40_002,
    connections: expect.toBeFunction(),
    close: expect.toBeFunction(),
  });
});

test('it keeps the port a TCP listener asks for', async () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  const listener = await ssh.backend.openListener('box', { network: 'tcp', port: 9000 }, null);

  expect(listener.port).toBe(9000);
});

test('it records the kind each listen asked for', async () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  await ssh.backend.openListener('box', { network: 'ssh-agent' }, 'ssh');
  await ssh.backend.openListener('box', { network: 'tcp', port: 9000 }, null);

  expect(ssh.listeners.map((listener) => listener.kind)).toStrictEqual(['ssh', null]);
});

test('it counts an ssh listener on the tracker until it closes', async () => {
  const ssh = buildStubSshBackend();
  const imp = buildMockImpRecord({ name: 'box' });

  ssh.putImp(imp);

  const listener = await ssh.backend.openListener('box', { network: 'ssh-agent' }, 'ssh');

  const countWhileOpen = ssh.tracker.count(imp.id, 'ssh');

  listener.close();

  expect(countWhileOpen).toBe(1);
  expect(ssh.tracker.count(imp.id)).toBe(0);
});

test('it counts nothing on the tracker for a listener of no kind', async () => {
  const ssh = buildStubSshBackend();
  const imp = buildMockImpRecord({ name: 'box' });

  ssh.putImp(imp);

  await ssh.backend.openListener('box', { network: 'tcp', port: 9000 }, null);

  expect(ssh.tracker.count(imp.id)).toBe(0);
});

test('it rejects a listen on an imp it does not hold as NOT_FOUND', () => {
  const ssh = buildStubSshBackend();
  const listen = ssh.backend.openListener('nobody', { network: 'ssh-agent' }, 'ssh');

  expect(listen).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('it yields the guest clients a test connects, until the listener ends', async () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  const listener = await ssh.backend.openListener('box', { network: 'ssh-agent' }, 'ssh');

  const [stub] = ssh.listeners;

  invariant(stub);

  stub.connect(1);
  stub.connect(2);
  stub.end();

  const connections = await Array.fromAsync(listener.connections());

  expect(connections).toStrictEqual([1, 2]);
});

test('it marks a listener closed when the gateway closes it', async () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  const listener = await ssh.backend.openListener('box', { network: 'ssh-agent' }, 'ssh');

  listener.close();

  expect(ssh.listeners[0]?.state.closed).toBeTrue();
});

test('it rejects a listen with the listen error a test sets', () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  ssh.stub.listenError = new Error('agent outdated');

  const listen = ssh.backend.openListener('box', { network: 'ssh-agent' }, 'ssh');

  expect(listen).rejects.toThrowWithMessage(Error, 'agent outdated');
});

test('it counts a held listen before it opens', () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  ssh.stub.listenGate = Promise.withResolvers<void>().promise;
  void ssh.backend.openListener('box', { network: 'ssh-agent' }, 'ssh');
  expect(ssh.stub.listenCalls).toBe(1);
  expect(ssh.listeners).toStrictEqual([]);
});

test('it opens a held listen once the gate opens', async () => {
  const ssh = buildStubSshBackend();
  const gate = Promise.withResolvers<void>();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  ssh.stub.listenGate = gate.promise;

  const listen = ssh.backend.openListener('box', { network: 'ssh-agent' }, 'ssh');

  gate.resolve();

  const listener = await listen;

  expect(listener.id).toBe('stub1');
});

test('it relays what a test sends for a guest client, and records what comes back', async () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  const relay = await ssh.backend.openAccept('box', 'stub1', 1, 'ssh');

  const [accept] = ssh.accepts;

  invariant(accept);

  accept.send('list');
  relay.write(new TextEncoder().encode('agent:list'));
  accept.sendEof();
  relay.end();

  const events = await Array.fromAsync(relay.events());

  expect(events).toStrictEqual([
    { type: 'data', data: new TextEncoder().encode('list') },
    { type: 'eof' },
  ]);

  expect(accept).toStrictEqual({
    listener: 'stub1',
    id: 1,
    kind: 'ssh',
    input: ['agent:list', '<eof>'],
    send: expect.toBeFunction(),
    sendEof: expect.toBeFunction(),
    state: { closed: false, ended: true },
  });
});

// the agent sends stdinEof on and keeps relaying the guest client's answer
test('it keeps a relay open after the gateway half-closes, until the guest client closes', async () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  const relay = await ssh.backend.openAccept('box', 'stub1', 1, 'ssh');

  const [accept] = ssh.accepts;

  invariant(accept);

  relay.end();
  accept.send('late answer');
  accept.sendEof();

  const events = await Array.fromAsync(relay.events());

  expect(events).toStrictEqual([
    { type: 'data', data: new TextEncoder().encode('late answer') },
    { type: 'eof' },
  ]);
});

test('it keeps a relay open after the guest client closes, until the gateway half-closes', async () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  const relay = await ssh.backend.openAccept('box', 'stub1', 1, 'ssh');

  const [accept] = ssh.accepts;

  invariant(accept);

  accept.sendEof();

  const isEndedBefore = accept.state.ended;

  relay.end();

  const events = await Array.fromAsync(relay.events());

  expect(isEndedBefore).toBeFalse();
  expect(accept.state.ended).toBeTrue();
  expect(events).toStrictEqual([{ type: 'eof' }]);
});

test('it counts an open relay on the tracker under its kind until it closes', async () => {
  const ssh = buildStubSshBackend();
  const imp = buildMockImpRecord({ name: 'box' });

  ssh.putImp(imp);

  const relay = await ssh.backend.openAccept('box', 'stub1', 1, 'tunnel');

  const countWhileOpen = ssh.tracker.count(imp.id, 'tunnel');

  relay.close();

  expect(countWhileOpen).toBe(1);
  expect(ssh.tracker.count(imp.id)).toBe(0);
});

test('it marks a guest client closed when the gateway closes its relay', async () => {
  const ssh = buildStubSshBackend();

  ssh.putImp(buildMockImpRecord({ name: 'box' }));

  const relay = await ssh.backend.openAccept('box', 'stub1', 1, 'ssh');

  relay.close();

  expect(ssh.accepts[0]?.state.closed).toBeTrue();
});
