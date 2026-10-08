import { expect, test } from 'bun:test';
import tar from 'tar-stream';
import { buildStubAgentTar } from './build-stub-agent-tar';

test('it writes a file entry with its content and mode 0644', async () => {
  const archive = await buildStubAgentTar([{ name: 'proj/run', content: 'hello' }]);

  const extract = tar.extract();

  extract.end(archive);

  const entries: unknown[] = [];

  for await (const entry of extract) {
    const chunks = await Array.fromAsync(entry);

    const text = Buffer.concat(chunks.filter((chunk) => chunk instanceof Uint8Array)).toString();

    entries.push({ ...entry.header, text });
  }

  expect(entries).toStrictEqual([
    expect.objectContaining({
      name: 'proj/run',
      type: 'file',
      mode: 0o644,
      size: 5,
      text: 'hello',
    }),
  ]);
});

test('it writes an entry without content with mode 0755 and the header it was given', async () => {
  const archive = await buildStubAgentTar([
    { name: 'proj/', type: 'directory', pax: { 'IMP.total': '5' } },
    { name: 'proj/link', type: 'symlink', linkname: 'run', mode: 0o777 },
  ]);

  const extract = tar.extract();

  extract.end(archive);

  const headers: unknown[] = [];

  for await (const entry of extract) {
    headers.push(entry.header);
    entry.resume();
  }

  expect(headers).toStrictEqual([
    expect.objectContaining({
      name: 'proj/',
      type: 'directory',
      mode: 0o755,
      pax: expect.objectContaining({ 'IMP.total': '5' }) as unknown,
    }),
    expect.objectContaining({ name: 'proj/link', type: 'symlink', linkname: 'run', mode: 0o777 }),
  ]);
});

test('it ends an archive with no entries', async () => {
  const archive = await buildStubAgentTar([]);

  expect(archive).toHaveLength(1024);
  expect(archive).toSatisfy((bytes: Uint8Array) => bytes.every((byte) => byte === 0));
});
