import { expect, test } from 'bun:test';
import { startStubGithubReleases } from './start-stub-github-releases';

test('it redirects /latest to the latest tag page', async () => {
  await using releases = startStubGithubReleases({ latest: 'v1.2.3', assets: {} });

  const response = await fetch(`${releases.url}/latest`, { redirect: 'manual' });

  expect({ status: response.status, location: response.headers.get('location') }).toStrictEqual({
    status: 302,
    location: '/tag/v1.2.3',
  });
});

test('it redirects /latest to the releases page when there is no release', async () => {
  await using releases = startStubGithubReleases({ latest: null, assets: {} });

  const response = await fetch(`${releases.url}/latest`, { redirect: 'manual' });

  expect({ status: response.status, location: response.headers.get('location') }).toStrictEqual({
    status: 302,
    location: '/',
  });
});

test('it answers on a tag page', async () => {
  await using releases = startStubGithubReleases({ latest: 'v1.2.3', assets: {} });

  const response = await fetch(`${releases.url}/tag/v1.2.3`);

  expect(response.status).toBe(200);
});

test('it serves an asset under its tag', async () => {
  await using releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: { 'v1.2.3/SHA256SUMS': 'the sums' },
  });

  const response = await fetch(`${releases.url}/download/v1.2.3/SHA256SUMS`);
  const body = await response.text();

  expect(body).toBe('the sums');
});

test('it answers 404 for an asset it does not have', async () => {
  await using releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: { 'v1.2.3/SHA256SUMS': 'the sums' },
  });

  const response = await fetch(`${releases.url}/download/v1.0.0/SHA256SUMS`);

  expect(response.status).toBe(404);
});

test('it records the path of each request in order', async () => {
  await using releases = startStubGithubReleases({ latest: 'v1.2.3', assets: {} });

  await fetch(`${releases.url}/latest`);
  await fetch(`${releases.url}/download/v1.2.3/imp-linux-x64`);

  expect(releases.requests).toStrictEqual([
    '/latest',
    '/tag/v1.2.3',
    '/download/v1.2.3/imp-linux-x64',
  ]);
});
