import { afterEach, expect } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as jestDOMMatchers from '@testing-library/jest-dom/matchers';

// Bun's own fetch stack survives happy-dom: the client's Request and
// AbortSignal must come from one implementation
const nativeFetchStack = {
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
  Blob: globalThis.Blob,
  fetch: globalThis.fetch,
  Headers: globalThis.Headers,
  ReadableStream: globalThis.ReadableStream,
  Request: globalThis.Request,
  Response: globalThis.Response,
  TextDecoder: globalThis.TextDecoder,
  TextEncoder: globalThis.TextEncoder,
  TransformStream: globalThis.TransformStream,
  WritableStream: globalThis.WritableStream,
};

GlobalRegistrator.register({ url: 'http://impd.test/ui/' });
Object.assign(globalThis, nativeFetchStack);

expect.extend(jestDOMMatchers);

// imported after the DOM exists: Testing Library reads `document` on import
const reactTestingLibrary = await import('@testing-library/react');

afterEach(() => {
  reactTestingLibrary.cleanup();
});
