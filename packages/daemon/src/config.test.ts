import { expect, test } from 'bun:test';
import { loadConfig } from './config';

test('it fills every setting from its default when the env is empty', () => {
  const config = loadConfig({});

  expect(config).toEqual({
    dataDir: '/var/lib/imp',
    apiPort: 7070,
    proxyPort: 7080,
    portBase: 20_000,
    ramBudgetMib: 16_384,
    idleTimeoutS: 60,
    idleCpuPercent: 10,
    bootReservePercent: 50,
    wakeReserveMib: 256,
    defaultVcpus: 2,
    defaultMemoryMib: 2048,
    dns: ['1.1.1.1', '8.8.8.8'],
    subnet: { network: 0x0a_42_00_00, prefixLength: 16 },
    firecrackerBin: 'firecracker',
    kernelPath: '/var/lib/imp/system/vmlinux',
    kernelSource: null,
    systemDriveSource: '/var/lib/imp/system/imp-system.squashfs',
    defaultImage: 'base',
    tailscaleAuthKey: null,
    tailscaleHostname: 'imp',
  });
});

test('it reads and coerces values from the env', () => {
  const config = loadConfig({
    IMP_DATA_DIR: '/tmp/imp',
    IMP_API_PORT: '9000',
    IMP_DNS: '9.9.9.9 , 1.0.0.1',
    IMP_SUBNET: '10.99.0.0/24',
    IMP_KERNEL: '/src/kernel/out/vmlinux',
    TAILSCALE_AUTHKEY: 'tskey-auth-test',
  });

  expect(config.dataDir).toBe('/tmp/imp');
  expect(config.apiPort).toBe(9000);
  expect(config.dns).toEqual(['9.9.9.9', '1.0.0.1']);
  expect(config.subnet.prefixLength).toBe(24);
  expect(config.kernelPath).toBe('/tmp/imp/system/vmlinux');
  expect(config.kernelSource).toBe('/src/kernel/out/vmlinux');
  expect(config.tailscaleAuthKey).toBe('tskey-auth-test');
});

test('it treats an empty variable as unset', () => {
  expect(loadConfig({ TAILSCALE_AUTHKEY: '', IMP_API_PORT: '' }).tailscaleAuthKey).toBeNull();
});

test('it rejects invalid values', () => {
  expect(() => loadConfig({ IMP_API_PORT: 'http' })).toThrow();
  expect(() => loadConfig({ IMP_DNS: 'one.one.one.one' })).toThrow();
  expect(() => loadConfig({ IMP_SUBNET: '10.66.0.0' })).toThrow();
});

test('it rejects a port base that cannot fit every slot', () => {
  expect(() => loadConfig({ IMP_PORT_BASE: '60000' })).toThrow('IMP_PORT_BASE');
});
