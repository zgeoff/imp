import { expect, test } from 'bun:test';
import { parseHostName } from './parse-host-name';

test('it takes the imp name from the first label', () => {
  expect(parseHostName('dev.imp.localhost:7080')).toBe('dev');
  expect(parseHostName('dev.imp.localhost')).toBe('dev');
  expect(parseHostName('Web-1.example.com.')).toBe('web-1');
  expect(parseHostName('api.imp.tail1234.ts.net:7080')).toBe('api');
});

test('it gives null for hosts that name no imp', () => {
  expect(parseHostName(null)).toBeNull();
  expect(parseHostName('localhost:7080')).toBeNull();
  expect(parseHostName('imp')).toBeNull();
  expect(parseHostName('10.66.0.2:8080')).toBeNull();
  expect(parseHostName('[::1]:7080')).toBeNull();
  expect(parseHostName('9lives.example.com')).toBeNull();
});
