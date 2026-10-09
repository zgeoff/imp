import { expect, mock, test } from 'bun:test';
import { IMAGE_BUILD_STREAM_TYPE } from '@imp/api';
import { buildStubImpdBeforeBuildStream } from './build-stub-impd-before-build-stream';

test('it sends an image build on without its Accept header', async () => {
  const received = mock<(accept: string | null, body: string) => void>();

  const older = buildStubImpdBeforeBuildStream(async (request) => {
    const body = await request.text();

    received(request.headers.get('accept'), body);

    return new Response(null, { status: 204 });
  });

  await older(
    new Request('http://impd.test/images/build?name=web', {
      method: 'POST',
      headers: { accept: `${IMAGE_BUILD_STREAM_TYPE}, application/json` },
      body: 'tar',
    }),
  );

  expect(received).toHaveBeenCalledExactlyOnceWith(null, 'tar');
});

test('it passes another call on with its Accept header', async () => {
  const received = mock<(accept: string | null) => void>();

  const older = buildStubImpdBeforeBuildStream((request) => {
    received(request.headers.get('accept'));

    return Promise.resolve(new Response(null, { status: 204 }));
  });

  await older(
    new Request('http://impd.test/rpc/imps/list', {
      method: 'POST',
      headers: { accept: 'application/json' },
    }),
  );

  expect(received).toHaveBeenCalledExactlyOnceWith('application/json');
});
