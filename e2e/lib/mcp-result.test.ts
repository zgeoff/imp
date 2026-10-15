import { expect, test } from 'bun:test';
import { readToolData } from './mcp-result';

test('it reads the structured answer of a call', () => {
  expect(
    readToolData({
      content: [{ type: 'text', text: '{"destroyed":"e2e-mcp-a"}' }],
      structuredContent: { destroyed: 'e2e-mcp-a' },
      isError: false,
    }),
  ).toStrictEqual({ destroyed: 'e2e-mcp-a' });
});

test('it reads a call without a structured answer as empty', () => {
  expect(readToolData({ content: [], isError: false })).toStrictEqual({});
});

test('it throws with the text of a failed call', () => {
  expect(() =>
    readToolData({
      content: [{ type: 'text', text: 'NOT_FOUND: imp e2e-mcp-a not found' }],
      isError: true,
    }),
  ).toThrowWithMessage(TypeError, 'the tool failed: NOT_FOUND: imp e2e-mcp-a not found');
});
