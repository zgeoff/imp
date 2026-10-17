import { expect, test } from 'bun:test';
import { buildProtocolSchema } from '@impz/api';
import { buildJsonOutputSchema } from './build-json-output-schema';

test('it covers the commands other programs read, each with the procedure it prints', () => {
  const outputs = buildJsonOutputSchema().outputs;

  expect(
    Object.entries(outputs).map(([command, output]) => [command, output.procedure]),
  ).toStrictEqual([
    ['info', 'system.info'],
    ['info <name>', 'imps.get'],
    ['ls', 'imps.list'],
    ['db copy', 'system.copyDatabase'],
  ]);
});

test('it takes each command’s schema from its procedure’s output in the protocol', () => {
  const procedures = buildProtocolSchema().procedures;

  expect(buildJsonOutputSchema().outputs['info']?.schema).toStrictEqual(
    procedures['system.info']?.output,
  );
});
