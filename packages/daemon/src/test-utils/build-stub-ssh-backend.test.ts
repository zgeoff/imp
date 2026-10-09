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

test('it records an exec’s request, stdin, resizes and signals', async () => {
  const ssh = buildStubSshBackend();

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

  await ssh.backend.openExec('box', { argv: ['true'], tty: false }, undefined, {
    kind: 'ssh',
    name: 'ci',
  });

  expect(ssh.actors).toStrictEqual([{ kind: 'ssh', name: 'ci' }]);
});

test('it yields the events a test emits on an exec, until null', async () => {
  const ssh = buildStubSshBackend();

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

test('it rejects an exec with the exec error a test sets', () => {
  const ssh = buildStubSshBackend();

  ssh.stub.execError = new Error('agent outdated');

  const exec = ssh.backend.openExec('box', { argv: ['true'], tty: false }, undefined, {
    kind: 'ssh',
    name: 'ci',
  });

  expect(exec).rejects.toThrowWithMessage(Error, 'agent outdated');
});

// as an HTTP server answers a whole request
test('it answers a dial with got and its input once the client half-closes', async () => {
  const ssh = buildStubSshBackend();

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

test('it records each dial’s target and input', async () => {
  const ssh = buildStubSshBackend();

  const dial = await ssh.backend.openDial(
    'box',
    { network: 'unix', address: '/run/app.sock' },
    'ssh',
  );

  dial.write(new TextEncoder().encode('ping'));

  expect(ssh.dials).toStrictEqual([
    { target: { network: 'unix', address: '/run/app.sock' }, input: ['ping'] },
  ]);
});

test('it rejects a dial with the dial error a test sets', () => {
  const ssh = buildStubSshBackend();

  ssh.stub.dialError = new Error('connection refused');

  const dial = ssh.backend.openDial('box', { network: 'tcp', address: '127.0.0.1:9' }, 'ssh');

  expect(dial).rejects.toThrowWithMessage(Error, 'connection refused');
});

test('it puts an ssh-agent listener’s socket under /run/imp/ssh-agent', async () => {
  const ssh = buildStubSshBackend();

  const listener = await ssh.backend.openListener('box', { network: 'ssh-agent' }, 'ssh');

  expect(listener).toMatchObject({
    id: 'stub1',
    path: '/run/imp/ssh-agent/stub1/agent.sock',
    port: null,
  });
});

test('it puts a unix listener’s socket at the path asked for', async () => {
  const ssh = buildStubSshBackend();

  const listener = await ssh.backend.openListener(
    'box',
    { network: 'unix', path: '/home/dev/app.sock' },
    'ssh',
  );

  expect(listener).toMatchObject({ path: '/home/dev/app.sock', port: null });
});

test('it picks 40000 plus the listener count for a TCP listener asked for port 0', async () => {
  const ssh = buildStubSshBackend();

  await ssh.backend.openListener('box', { network: 'ssh-agent' }, 'ssh');

  const listener = await ssh.backend.openListener('box', { network: 'tcp', port: 0 }, 'ssh');

  expect(listener).toMatchObject({ path: null, port: 40_002 });
});

test('it keeps the port a TCP listener asks for', async () => {
  const ssh = buildStubSshBackend();

  const listener = await ssh.backend.openListener('box', { network: 'tcp', port: 9000 }, 'ssh');

  expect(listener.port).toBe(9000);
});

test('it yields the guest clients a test connects, until the listener ends', async () => {
  const ssh = buildStubSshBackend();

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

  const listener = await ssh.backend.openListener('box', { network: 'ssh-agent' }, 'ssh');

  listener.close();

  expect(ssh.listeners[0]?.state.closed).toBeTrue();
});

test('it rejects a listen with the listen error a test sets', () => {
  const ssh = buildStubSshBackend();

  ssh.stub.listenError = new Error('agent outdated');

  const listen = ssh.backend.openListener('box', { network: 'ssh-agent' }, 'ssh');

  expect(listen).rejects.toThrowWithMessage(Error, 'agent outdated');
});

test('it relays what a test sends for a guest client, and records what comes back', async () => {
  const ssh = buildStubSshBackend();

  const relay = await ssh.backend.openAccept('box', 'stub1', 1, 'ssh');

  const [accept] = ssh.accepts;

  invariant(accept);

  accept.send('list');
  relay.write(new TextEncoder().encode('agent:list'));
  relay.end();

  const events = await Array.fromAsync(relay.events());

  expect(events).toStrictEqual([{ type: 'data', data: new TextEncoder().encode('list') }]);
  expect(accept).toMatchObject({ listener: 'stub1', id: 1, input: ['agent:list'] });
});

test('it marks a guest client closed when the gateway closes its relay', async () => {
  const ssh = buildStubSshBackend();

  const relay = await ssh.backend.openAccept('box', 'stub1', 1, 'ssh');

  relay.close();

  expect(ssh.accepts[0]?.state.closed).toBeTrue();
});
