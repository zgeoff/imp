import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendRawBuild, writeBuildContext } from './build-context';

async function setupTest() {
  const root = await mkdtemp(join(tmpdir(), 'build-context-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  return { root };
}

test('#writeBuildContext makes a named directory that holds the Dockerfile', async () => {
  const ctx = await setupTest();
  const dir = await writeBuildContext(ctx.root, 'syntax', 'FROM busybox:1.37\n');
  const dockerfile = await readFile(join(ctx.root, 'syntax', 'Dockerfile'), 'utf8');

  expect(dir).toBe(join(ctx.root, 'syntax'));
  expect(dockerfile).toBe('FROM busybox:1.37\n');
});

test('#sendRawBuild posts a tar of exactly the named files with the token and image name', async () => {
  const ctx = await setupTest();

  const received: { url: string; authorization: string | null; type: string | null }[] = [];
  const bodies = join(ctx.root, 'received.tar');

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      received.push({
        url: request.url,
        authorization: request.headers.get('authorization'),
        type: request.headers.get('content-type'),
      });

      const body = await request.arrayBuffer();

      await writeFile(bodies, new Uint8Array(body));

      return new Response('ok');
    },
  });

  onTestFinished(() => server.stop(true));

  const dir = await writeBuildContext(ctx.root, 'ctx', 'FROM busybox:1.37\n');

  await writeFile(join(dir, 'kept.txt'), 'kept');
  await writeFile(join(dir, 'left-out.txt'), 'left out');

  const response = await sendRawBuild({
    apiUrl: `http://127.0.0.1:${String(server.port)}`,
    token: 'imp_test',
    dir,
    files: ['Dockerfile', 'kept.txt'],
    name: 'e2e-img-raw',
  });

  const listed = Bun.spawnSync(['tar', '-tf', bodies]).stdout.toString();

  expect(response.status).toBe(200);

  expect(received).toStrictEqual([
    {
      url: `http://127.0.0.1:${String(server.port)}/images/build?name=e2e-img-raw`,
      authorization: 'Bearer imp_test',
      type: 'application/x-tar',
    },
  ]);

  expect(listed).toBe('Dockerfile\nkept.txt\n');
});

test('#sendRawBuild throws with tar’s reason when a named file is missing', async () => {
  const ctx = await setupTest();
  const dir = await writeBuildContext(ctx.root, 'ctx', 'FROM busybox:1.37\n');

  expect(
    sendRawBuild({
      apiUrl: 'http://127.0.0.1:9',
      token: 'imp_test',
      dir,
      files: ['missing.txt'],
      name: 'e2e-img-raw',
    }),
  ).rejects.toThrowWithMessage(Error, /^tar exited 2: .*missing\.txt/);
});
