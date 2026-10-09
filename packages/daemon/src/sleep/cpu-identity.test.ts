import { expect, test } from 'bun:test';
import { findCpuChange, parseCpuInfo } from './cpu-identity';

test('#parseCpuInfo reads the model of the first processor', () => {
  const cpu = parseCpuInfo(
    'processor\t: 0\nmodel name\t: AMD EPYC 9454P 48-Core Processor\nflags\t\t: fpu sse\n\n' +
      'processor\t: 1\nmodel name\t: Other\nflags\t\t: fpu\n',
  );

  expect(cpu.cpuModel).toBe('AMD EPYC 9454P 48-Core Processor');
});

test('#parseCpuInfo hashes the flags of the first processor', () => {
  const cpu = parseCpuInfo('processor\t: 0\nmodel name\t: AMD EPYC\nflags\t\t: fpu vme sse avx2\n');

  expect(cpu.cpuFlags).toMatch(/^[0-9a-f]{64}$/);
});

test('#parseCpuInfo hashes the same flags in any order alike', () => {
  const cpu = parseCpuInfo('processor\t: 0\nmodel name\t: AMD EPYC\nflags\t\t: fpu vme sse avx2\n');

  const reordered = parseCpuInfo(
    'processor\t: 0\nmodel name\t: AMD EPYC\nflags\t\t: avx2 sse vme fpu\n',
  );

  expect(reordered.cpuFlags).toBe(cpu.cpuFlags);
});

test('#parseCpuInfo hashes other flags differently', () => {
  const cpu = parseCpuInfo('processor\t: 0\nmodel name\t: AMD EPYC\nflags\t\t: fpu vme sse avx2\n');
  const fewer = parseCpuInfo('processor\t: 0\nmodel name\t: AMD EPYC\nflags\t\t: fpu vme sse\n');

  expect(fewer.cpuFlags).not.toBe(cpu.cpuFlags);
});

test('#parseCpuInfo reads the model of an arm64 CPU from its CPU part', () => {
  expect(parseCpuInfo('processor\t: 0\nFeatures\t: fp asimd\nCPU part\t: 0xd0c\n').cpuModel).toBe(
    '0xd0c',
  );
});

test('#parseCpuInfo reads a CPU with neither model nor flags as unknown', () => {
  expect(parseCpuInfo('processor\t: 0\n')).toStrictEqual({
    cpuModel: 'unknown',
    cpuFlags: 'unknown',
  });
});

test('#findCpuChange finds no change on the same CPU', () => {
  expect(
    findCpuChange(
      { cpuModel: 'AMD EPYC', cpuFlags: 'a'.repeat(64) },
      {
        cpuModel: 'AMD EPYC',
        cpuFlags: 'a'.repeat(64),
      },
    ),
  ).toBeNull();
});

test('#findCpuChange lets a snapshot that recorded no CPU load', () => {
  expect(findCpuChange({}, { cpuModel: 'AMD EPYC', cpuFlags: 'a'.repeat(64) })).toBeNull();
});

test('#findCpuChange names both models when the model changed', () => {
  expect(
    findCpuChange(
      { cpuModel: 'Intel Xeon', cpuFlags: 'a'.repeat(64) },
      {
        cpuModel: 'AMD EPYC',
        cpuFlags: 'a'.repeat(64),
      },
    ),
  ).toBe('the CPU changed (Intel Xeon → AMD EPYC)');
});

test('#findCpuChange says the flags changed when only the flags changed', () => {
  expect(
    findCpuChange(
      { cpuModel: 'AMD EPYC', cpuFlags: 'b'.repeat(64) },
      {
        cpuModel: 'AMD EPYC',
        cpuFlags: 'a'.repeat(64),
      },
    ),
  ).toBe('the CPU flags changed');
});
