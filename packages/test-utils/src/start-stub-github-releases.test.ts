import { expect, onTestFinished, test } from 'bun:test';
import { startStubGithubReleases } from './start-stub-github-releases';

test('it redirects /latest to the latest tag page', async () => {
  const releases = startStubGithubReleases({ latest: 'v1.2.3', assets: {} });

  const response = await fetch(`${releases.url}/latest`, { redirect: 'manual' });

  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('/tag/v1.2.3');
});

test('it redirects /latest to the releases page when there is no release', async () => {
  const releases = startStubGithubReleases({ latest: null, assets: {} });

  const response = await fetch(`${releases.url}/latest`, { redirect: 'manual' });

  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('/');
});

test('it answers on a tag page', async () => {
  const releases = startStubGithubReleases({ latest: 'v1.2.3', assets: {} });

  const response = await fetch(`${releases.url}/tag/v1.2.3`);

  expect(response.status).toBe(200);
});

test('it serves an asset under its tag', async () => {
  const releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: { 'v1.2.3/SHA256SUMS': 'the sums' },
  });

  const response = await fetch(`${releases.url}/download/v1.2.3/SHA256SUMS`);
  const body = await response.text();

  expect(body).toBe('the sums');
});

test('it answers 404 for an asset it does not have', async () => {
  const releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: { 'v1.2.3/SHA256SUMS': 'the sums' },
  });

  const response = await fetch(`${releases.url}/download/v1.0.0/SHA256SUMS`);

  expect(response.status).toBe(404);
});

test('it records the path of each request in order', async () => {
  const releases = startStubGithubReleases({ latest: 'v1.2.3', assets: {} });

  await fetch(`${releases.url}/latest`);
  await fetch(`${releases.url}/download/v1.2.3/imp-linux-x64`);

  expect(releases.requests).toStrictEqual([
    '/latest',
    '/tag/v1.2.3',
    '/download/v1.2.3/imp-linux-x64',
  ]);
});

test('it stops serving when the test finishes', () => {
  const releases = startStubGithubReleases({ latest: 'v1.2.3', assets: {} });

  // registered after the stub's own stop, so it runs once the server is gone
  onTestFinished(() => {
    expect(fetch(`${releases.url}/latest`)).rejects.toThrow();
  });
});
