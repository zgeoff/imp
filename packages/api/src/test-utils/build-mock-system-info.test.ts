import { expect, test } from 'bun:test';
import { SystemInfoSchema } from '../system-info-schema';
import { buildMockSystemInfo } from './build-mock-system-info';

test('it builds a default system info', () => {
  const info = buildMockSystemInfo();
  const parsed: unknown = SystemInfoSchema.safeParse(info).data;
  const received: unknown = info;

  expect(received).toStrictEqual({
    version: expect.stringMatching(/^\d+\.\d+\.\d+$/) as unknown,
    ramBudgetMib: expect.any(Number) as unknown,
    ramUsedMib: expect.any(Number) as unknown,
    ramReservedMib: expect.any(Number) as unknown,
    ramCommittedMib: expect.any(Number) as unknown,
    ramSleepingMib: expect.any(Number) as unknown,
    awakeCount: expect.any(Number) as unknown,
    impCount: expect.any(Number) as unknown,
    sessionCount: expect.any(Number) as unknown,
    bootStatus: { coldBoots: 0, outdated: { firecracker: 0, kernel: 0, agent: 0, ipv6: 0 } },
    firecrackerVersion: expect.stringMatching(/^v\d+\.\d+\.\d+$/) as unknown,
    guestKernel: {
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/) as unknown,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    },
    systemDrive: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown },
    storage: {
      backend: 'xfs',
      usedBytes: expect.any(Number) as unknown,
      availableBytes: expect.any(Number) as unknown,
      reserveBytes: expect.any(Number) as unknown,
      pendingBytes: expect.any(Number) as unknown,
      isLow: false,
      impDiskBytes: expect.any(Number) as unknown,
    },
    tailscale: { enabled: false, state: null, hostname: null, ip: null, names: null },
    ksm: null,
    cpu: { hostCpus: expect.any(Number) as unknown, limitsEnforced: true },
    defaults: {
      memoryMib: expect.any(Number) as unknown,
      image: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    },
    egress: { isEnforced: true },
    public: null,
    https: null,
    features: {
      sessionOffsets: true,
      leases: true,
      grantableTokens: true,
      secretRebind: true,
      tokenUpdate: true,
      databaseCopy: true,
      imageBuildStream: true,
      imageOpStream: true,
      execRequire: true,
      oauthGrants: true,
      secretFilesGc: true,
      sessionLog: true,
      publicEgress: true,
      oauthSecrets: true,
      secretUpstream: true,
    },
  });

  expect(parsed).toStrictEqual(info);
  expect(info.defaults?.memoryMib).toBeLessThanOrEqual(info.ramBudgetMib);
});

test('it applies overrides on top of the defaults', () => {
  const info: unknown = buildMockSystemInfo({
    ramBudgetMib: 2048,
    storage: { isLow: true },
    features: { publicEgress: false },
  });

  expect(info).toStrictEqual({
    version: expect.stringMatching(/^\d+\.\d+\.\d+$/) as unknown,
    ramBudgetMib: 2048,
    ramUsedMib: expect.any(Number) as unknown,
    ramReservedMib: expect.any(Number) as unknown,
    ramCommittedMib: expect.any(Number) as unknown,
    ramSleepingMib: expect.any(Number) as unknown,
    awakeCount: expect.any(Number) as unknown,
    impCount: expect.any(Number) as unknown,
    sessionCount: expect.any(Number) as unknown,
    bootStatus: { coldBoots: 0, outdated: { firecracker: 0, kernel: 0, agent: 0, ipv6: 0 } },
    firecrackerVersion: expect.stringMatching(/^v\d+\.\d+\.\d+$/) as unknown,
    guestKernel: {
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/) as unknown,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    },
    systemDrive: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown },
    storage: {
      backend: 'xfs',
      usedBytes: expect.any(Number) as unknown,
      availableBytes: expect.any(Number) as unknown,
      reserveBytes: expect.any(Number) as unknown,
      pendingBytes: expect.any(Number) as unknown,
      isLow: true,
      impDiskBytes: expect.any(Number) as unknown,
    },
    tailscale: { enabled: false, state: null, hostname: null, ip: null, names: null },
    ksm: null,
    cpu: { hostCpus: expect.any(Number) as unknown, limitsEnforced: true },
    defaults: {
      memoryMib: expect.any(Number) as unknown,
      image: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    },
    egress: { isEnforced: true },
    public: null,
    https: null,
    features: {
      sessionOffsets: true,
      leases: true,
      grantableTokens: true,
      secretRebind: true,
      tokenUpdate: true,
      databaseCopy: true,
      imageBuildStream: true,
      imageOpStream: true,
      execRequire: true,
      oauthGrants: true,
      secretFilesGc: true,
      sessionLog: true,
      publicEgress: false,
      oauthSecrets: true,
      secretUpstream: true,
    },
  });
});
