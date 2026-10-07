import { expect, test } from 'bun:test';
import { createModeWatcher } from './terminal-modes';

test('it turns mouse, focus and modifyOtherKeys off and shows the cursor after plain output', () => {
  const watcher = createModeWatcher();

  watcher.observe(new TextEncoder().encode('plain output'));

  expect(watcher.buildReset()).toBe(
    '\u001B[?9l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1005l\u001B[?1006l\u001B[?1015l\u001B[?1016l\u001B[?1004l\u001B[?25h\u001B[0m\u001B[>4;0m',
  );
});

test('it turns paste and cursor keys off when the session turned them on', () => {
  const watcher = createModeWatcher();

  watcher.observe(new TextEncoder().encode('\u001B[?2004h\u001B[?1h'));

  expect(watcher.buildReset()).toBe(
    '\u001B[?9l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1005l\u001B[?1006l\u001B[?1015l\u001B[?1016l\u001B[?1004l\u001B[?2004l\u001B[?1l\u001B[?25h\u001B[0m\u001B[>4;0m',
  );
});

test('it leaves paste alone when the session turned it on and off again', () => {
  const watcher = createModeWatcher();

  watcher.observe(new TextEncoder().encode('\u001B[?2004h'));
  watcher.observe(new TextEncoder().encode('\u001B[?2004l'));

  expect(watcher.buildReset()).toBe(
    '\u001B[?9l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1005l\u001B[?1006l\u001B[?1015l\u001B[?1016l\u001B[?1004l\u001B[?25h\u001B[0m\u001B[>4;0m',
  );
});

test('it leaves the alternate screen when the output entered it', () => {
  const watcher = createModeWatcher();

  watcher.observe(new TextEncoder().encode('\u001B[?1049hvim'));

  expect(watcher.buildReset()).toBe(
    '\u001B[?1049l\u001B[?9l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1005l\u001B[?1006l\u001B[?1015l\u001B[?1016l\u001B[?1004l\u001B[?25h\u001B[0m\u001B[>4;0m',
  );
});

test('it stays on the main screen when the output entered the alternate screen and left it', () => {
  const watcher = createModeWatcher();

  watcher.observe(new TextEncoder().encode('\u001B[?1049hvim'));
  watcher.observe(new TextEncoder().encode('bye\u001B[?1049l'));

  expect(watcher.buildReset()).toBe(
    '\u001B[?9l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1005l\u001B[?1006l\u001B[?1015l\u001B[?1016l\u001B[?1004l\u001B[?25h\u001B[0m\u001B[>4;0m',
  );
});

test('it leaves the alternate screen when the output entered it through mode 1047', () => {
  const watcher = createModeWatcher();

  watcher.observe(new TextEncoder().encode('\u001B[?47h\u001B[?47l\u001B[?1047h'));

  expect(watcher.buildReset()).toBe(
    '\u001B[?1049l\u001B[?9l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1005l\u001B[?1006l\u001B[?1015l\u001B[?1016l\u001B[?1004l\u001B[?25h\u001B[0m\u001B[>4;0m',
  );
});

test('it pops no kitty keyboard entry when the session set only modifyOtherKeys', () => {
  const watcher = createModeWatcher();

  watcher.observe(new TextEncoder().encode('\u001B[>4;1m'));

  expect(watcher.buildReset()).toBe(
    '\u001B[?9l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1005l\u001B[?1006l\u001B[?1015l\u001B[?1016l\u001B[?1004l\u001B[?25h\u001B[0m\u001B[>4;0m',
  );
});

test('it pops as many kitty keyboard entries as the session pushed', () => {
  const watcher = createModeWatcher();

  watcher.observe(new TextEncoder().encode('\u001B[>1u\u001B[>u'));

  expect(watcher.buildReset()).toBe(
    '\u001B[<2u\u001B[?9l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1005l\u001B[?1006l\u001B[?1015l\u001B[?1016l\u001B[?1004l\u001B[?25h\u001B[0m\u001B[>4;0m',
  );
});

test('it pops only the kitty keyboard entries the session left pushed', () => {
  const watcher = createModeWatcher();

  watcher.observe(new TextEncoder().encode('\u001B[>1u\u001B[>3u\u001B[<u'));

  expect(watcher.buildReset()).toBe(
    '\u001B[<1u\u001B[?9l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1005l\u001B[?1006l\u001B[?1015l\u001B[?1016l\u001B[?1004l\u001B[?25h\u001B[0m\u001B[>4;0m',
  );
});

test('it pops no kitty keyboard entry when the session popped more than it pushed', () => {
  const watcher = createModeWatcher();

  watcher.observe(new TextEncoder().encode('\u001B[>1u\u001B[<5u'));

  expect(watcher.buildReset()).toBe(
    '\u001B[?9l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1005l\u001B[?1006l\u001B[?1015l\u001B[?1016l\u001B[?1004l\u001B[?25h\u001B[0m\u001B[>4;0m',
  );
});

test('it pops the kitty keyboard entries of each screen before it leaves that screen', () => {
  const watcher = createModeWatcher();

  watcher.observe(new TextEncoder().encode('\u001B[>1u\u001B[?1049h\u001B[>3u\u001B[>3u'));

  expect(watcher.buildReset()).toBe(
    '\u001B[<2u\u001B[?1049l\u001B[<1u\u001B[?9l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1005l\u001B[?1006l\u001B[?1015l\u001B[?1016l\u001B[?1004l\u001B[?25h\u001B[0m\u001B[>4;0m',
  );
});

test('it reads a mode split across two chunks', () => {
  const watcher = createModeWatcher();

  watcher.observe(new TextEncoder().encode('\u001B[?20'));
  watcher.observe(new TextEncoder().encode('04h'));

  expect(watcher.buildReset()).toBe(
    '\u001B[?9l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1005l\u001B[?1006l\u001B[?1015l\u001B[?1016l\u001B[?1004l\u001B[?2004l\u001B[?25h\u001B[0m\u001B[>4;0m',
  );
});

test('it forgets what it saw when the output sends a full reset', () => {
  const watcher = createModeWatcher();

  watcher.observe(new TextEncoder().encode('\u001B[?2004h\u001B[>1u'));
  watcher.observe(new TextEncoder().encode('\u001Bc'));

  expect(watcher.buildReset()).toBe(
    '\u001B[?9l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1005l\u001B[?1006l\u001B[?1015l\u001B[?1016l\u001B[?1004l\u001B[?25h\u001B[0m\u001B[>4;0m',
  );
});
