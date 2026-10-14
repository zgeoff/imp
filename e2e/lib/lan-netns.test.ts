import { expect, test } from 'bun:test';
import { countLanConnections, parseTimedDial } from './lan-netns';

test('#countLanConnections counts the connections to each address the log shows', () => {
  const log = [
    '10.250.77.1 10.66.0.6',
    '169.254.77.1 10.66.0.6',
    '10.250.77.1 10.66.0.10',
    '',
  ].join('\n');

  expect(countLanConnections(log, ['10.250.77.1', '169.254.77.1'])).toStrictEqual({
    '10.250.77.1': 2,
    '169.254.77.1': 1,
  });
});

test('#countLanConnections counts an empty log as no connections', () => {
  expect(countLanConnections('', ['10.250.77.1'])).toStrictEqual({ '10.250.77.1': 0 });
});

test('#parseTimedDial reads a connection and its time', () => {
  expect(parseTimedDial('0 40 \n')).toStrictEqual({ isConnected: true, ms: 40, error: '' });
});

test('#parseTimedDial reads a refusal with the error wget named', () => {
  expect(
    parseTimedDial("1 10 wget: can't connect to remote host (10.250.77.1): Connection refused \n"),
  ).toStrictEqual({
    isConnected: false,
    ms: 10,
    error: "wget: can't connect to remote host (10.250.77.1): Connection refused",
  });
});
