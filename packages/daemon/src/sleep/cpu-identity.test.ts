import { expect, test } from 'bun:test';
import { findCpuChange, parseCpuInfo } from './cpu-identity';

const X86 = `processor\t: 0
vendor_id\t: AuthenticAMD
model name\t: AMD EPYC 9454P 48-Core Processor
flags\t\t: fpu vme sse avx2

processor\t: 1
model name\t: AMD EPYC 9454P 48-Core Processor
flags\t\t: fpu vme sse avx2
`;

test('the model and the flags come from the first processor, in any flag order', () => {
  const cpu = parseCpuInfo(X86);
  const reordered = parseCpuInfo(X86.replace('fpu vme sse avx2', 'avx2 sse vme fpu'));

  expect(cpu.cpuModel).toBe('AMD EPYC 9454P 48-Core Processor');
  expect(cpu.cpuFlags).toMatch(/^[0-9a-f]{64}$/);
  expect(reordered.cpuFlags).toBe(cpu.cpuFlags);
});

test('arm64 names them CPU part and Features; a CPU with neither is unknown', () => {
  expect(parseCpuInfo('processor\t: 0\nFeatures\t: fp asimd\nCPU part\t: 0xd0c\n')).toMatchObject({
    cpuModel: '0xd0c',
  });

  expect(parseCpuInfo('processor\t: 0\n')).toEqual({ cpuModel: 'unknown', cpuFlags: 'unknown' });
});

test('another model or flags keep a snapshot from loading; a snapshot without them loads', () => {
  const host = parseCpuInfo(X86);
  const fewer = parseCpuInfo(X86.replaceAll(' avx2', ''));

  expect(findCpuChange(host, host)).toBeNull();
  expect(findCpuChange({}, host)).toBeNull();

  expect(findCpuChange({ ...host, cpuModel: 'Intel Xeon' }, host)).toBe(
    'the CPU changed (Intel Xeon → AMD EPYC 9454P 48-Core Processor)',
  );

  expect(findCpuChange(fewer, host)).toBe('the CPU flags changed');
});
