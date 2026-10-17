import { expect, test } from 'bun:test';
import { readBodyText } from './read-body-text';

test('it reads a body of at most the limit as its text', async () => {
  const request = new Request('http://127.0.0.1/', { method: 'POST', body: 'grant_type=x' });

  const text = await readBodyText(request, 12);

  expect(text).toBe('grant_type=x');
});

test('it reads a body past the limit as null', async () => {
  const request = new Request('http://127.0.0.1/', { method: 'POST', body: 'grant_type=xy' });

  const text = await readBodyText(request, 12);

  expect(text).toBeNull();
});

test('it counts the limit in bytes, not characters', async () => {
  const request = new Request('http://127.0.0.1/', { method: 'POST', body: 'éé' });

  const text = await readBodyText(request, 3);

  expect(text).toBeNull();
});

test('it reads a request without a body as null', async () => {
  const text = await readBodyText(new Request('http://127.0.0.1/'), 12);

  expect(text).toBeNull();
});
