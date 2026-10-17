import { expect, mock, test } from 'bun:test';
import { SYSTEM_FEATURES } from '@impz/api';
import type { SystemFeaturesInfo, SystemInfo } from '@impz/api';
import { buildMockSystemInfo } from '@impz/api/test-utils/build-mock-system-info';
import { ORPCError } from '@orpc/client';
import invariant from 'tiny-invariant';
import { findMissingFeatures, readFeatures, requireFeatures } from './require-features';
import { UnknownProcedureError } from './unknown-procedure-error';

test('#requireFeatures resolves when impd reports every needed feature on', () => {
  const answer: SystemFeaturesInfo = { version: '2.4.1', features: SYSTEM_FEATURES };

  const source = {
    system: {
      features: () => Promise.resolve(answer),
      info: () => Promise.reject(new Error('not read')),
    },
  };

  expect(
    requireFeatures(source, { databaseCopy: 'copy it', grantFilters: 'grant it' }),
  ).resolves.toBeUndefined();
});

test('#requireFeatures refuses naming what the impd without the feature would do', () => {
  const answer: SystemFeaturesInfo = {
    version: '0.29.0',
    features: { ...SYSTEM_FEATURES, databaseCopy: false },
  };

  const source = {
    system: {
      features: () => Promise.resolve(answer),
      info: () => Promise.reject(new Error('not read')),
    },
  };

  expect(requireFeatures(source, { databaseCopy: 'not know the call' })).rejects.toMatchObject({
    name: 'MissingFeatureError',
    feature: 'databaseCopy',
    gap: 'is older than 0.30.0',
    outcome: 'not know the call',
    message: 'this impd is older than 0.30.0 and would not know the call; nothing was changed',
  });
});

test('#requireFeatures reads the features once for several needs', async () => {
  const answer: SystemFeaturesInfo = { version: '2.4.1', features: SYSTEM_FEATURES };
  const features = mock(() => Promise.resolve(answer));

  await requireFeatures(
    { system: { features, info: () => Promise.reject(new Error('not read')) } },
    { secretRebind: 'keep it', secretUpstream: 'send it', oauthSecrets: 'refuse it' },
  );

  expect(features).toHaveBeenCalledOnce();
});

test('#requireFeatures reads nothing when the call needs no feature', async () => {
  const features = mock(() => Promise.reject(new Error('not read')));

  await requireFeatures(
    { system: { features, info: () => Promise.reject(new Error('not read')) } },
    {},
  );

  expect(features).not.toHaveBeenCalled();
});

test('#requireFeatures refuses the first need in order that impd lacks', () => {
  const answer: SystemFeaturesInfo = {
    version: '0.26.0',
    features: { ...SYSTEM_FEATURES, secretUpstream: false, oauthSecrets: false },
  };

  const source = {
    system: {
      features: () => Promise.resolve(answer),
      info: () => Promise.reject(new Error('not read')),
    },
  };

  expect(
    requireFeatures(source, { oauthSecrets: 'refuse the kind', secretUpstream: 'send it' }),
  ).rejects.toMatchObject({ feature: 'oauthSecrets' });
});

test('#requireFeatures passes on a failed feature read as it came', () => {
  const failure = new Error('impd is down');

  const source = {
    system: {
      features: () => Promise.reject(failure),
      info: () => Promise.reject(new Error('not read')),
    },
  };

  expect(requireFeatures(source, { databaseCopy: 'copy it' })).rejects.toBe(failure);
});

test('#readFeatures reads system.info on an impd that answers system.features with NOT_FOUND', () => {
  const info = buildMockSystemInfo({ features: { databaseCopy: true } });

  const source = {
    system: {
      features: () => Promise.reject(new ORPCError('NOT_FOUND')),
      info: () => Promise.resolve(info),
    },
  };

  invariant(info.features);

  expect(readFeatures(source)).resolves.toStrictEqual(info.features);
});

test('#readFeatures reads system.info on an impd whose router has no system.features path', () => {
  const info = buildMockSystemInfo({ features: { sessionLog: true } });

  const source = {
    system: {
      features: () => Promise.reject(new UnknownProcedureError('system.features')),
      info: () => Promise.resolve(info),
    },
  };

  invariant(info.features);

  expect(readFeatures(source)).resolves.toStrictEqual(info.features);
});

test('#readFeatures reads no feature from an impd from before the features object', () => {
  const { features: _absent, ...info } = buildMockSystemInfo();

  const source = {
    system: {
      features: () => Promise.reject(new ORPCError('NOT_FOUND')),
      info: () => Promise.resolve<SystemInfo>(info),
    },
  };

  expect(readFeatures(source)).resolves.toStrictEqual({});
});

test('#readFeatures passes on a refusal of system.features that is no missing procedure', () => {
  const refusal = new ORPCError('UNAUTHORIZED');

  const source = {
    system: {
      features: () => Promise.reject(refusal),
      info: () => Promise.reject(new Error('not read')),
    },
  };

  expect(readFeatures(source)).rejects.toBe(refusal);
});

test('#findMissingFeatures names the wanted features a system.info answer lacks', () => {
  const info = buildMockSystemInfo({ features: { publicEgress: false, sessionLog: true } });

  expect(findMissingFeatures(info, ['sessionLog', 'publicEgress'])).toStrictEqual(['publicEgress']);
});
