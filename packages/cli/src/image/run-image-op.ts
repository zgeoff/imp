import type { Image, ImageOpEvent } from '@imp/api';
import type { ImpClient } from '../create-imp-client';
import { createBuildStatus } from './build-status';

type AddInput = Parameters<ImpClient['images']['add']>[0];

type BuildInput = Parameters<ImpClient['images']['build']>[0];

// images.add (an image or a template) through its stream on an impd that
// has one, with its phase line on a terminal; the plain call on an older one
export async function runImageAdd(
  client: Pick<ImpClient, 'images' | 'system'>,
  input: AddInput,
  label: string,
): Promise<Image> {
  if (!(await hasImageOpStream(client))) {
    return client.images.add(input);
  }

  const events = await client.images.addStream(input);

  return readImageOp(events, label);
}

// images.build from a directory on the impd host, as runImageAdd
export async function runOnHostBuild(
  client: Pick<ImpClient, 'images' | 'system'>,
  input: BuildInput,
): Promise<Image> {
  if (!(await hasImageOpStream(client))) {
    return client.images.build(input);
  }

  const events = await client.images.buildStream(input);

  return readImageOp(events, 'imp image build');
}

// An impd from before the streams answers only when the work ends, so a
// pull or a build longer than the client's fetch waits fails there
async function hasImageOpStream(client: Pick<ImpClient, 'system'>): Promise<boolean> {
  const info = await client.system.info();

  return info.features?.imageOpStream === true;
}

async function readImageOp(
  events: Readonly<AsyncIterable<ImageOpEvent>>,
  label: string,
): Promise<Image> {
  const status = createBuildStatus(
    {
      isTTY: process.stderr.isTTY,
      write: (text) => {
        process.stderr.write(text);
      },
    },
    label,
  );

  try {
    for await (const event of events) {
      if (event.type === 'image') {
        return event.image;
      }

      status.show(event);
    }
  } finally {
    status.finish();
  }

  throw new Error('impd ended the stream before it answered the image');
}
