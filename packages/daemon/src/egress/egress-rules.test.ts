import { expect, test } from 'bun:test';
import {
  buildAllowRules,
  isAddressAllowed,
  isNameAllowed,
  isTunnelAllowed,
  listExactNames,
} from './egress-rules';

const RULES = buildAllowRules(['github.com', '*.npmjs.org', '172.17.0.1', '203.0.113.0/24']);

test('an exact name matches itself in any case, with or without the trailing dot', () => {
  for (const name of ['github.com', 'GitHub.COM', 'github.com.']) {
    expect({ name, allowed: isNameAllowed(RULES, name) }).toEqual({ name, allowed: true });
  }

  for (const name of ['api.github.com', 'github.com.evil.test', 'xgithub.com']) {
    expect({ name, allowed: isNameAllowed(RULES, name) }).toEqual({ name, allowed: false });
  }
});

test('a wildcard matches subdomains at any depth, not the name itself', () => {
  for (const name of ['registry.npmjs.org', 'a.b.npmjs.org', 'REGISTRY.npmjs.org.']) {
    expect({ name, allowed: isNameAllowed(RULES, name) }).toEqual({ name, allowed: true });
  }

  for (const name of ['npmjs.org', 'evilnpmjs.org', 'npmjs.org.evil.test']) {
    expect({ name, allowed: isNameAllowed(RULES, name) }).toEqual({ name, allowed: false });
  }
});

test('an address entry is a /32, and a CIDR covers its range', () => {
  expect(RULES.cidrs).toEqual(['172.17.0.1/32', '203.0.113.0/24']);

  for (const [address, allowed] of [
    ['172.17.0.1', true],
    ['172.17.0.2', false],
    ['203.0.113.0', true],
    ['203.0.113.255', true],
    ['203.0.114.0', false],
    ['github.com', false],
  ] as const) {
    expect({ address, allowed: isAddressAllowed(RULES, address) }).toEqual({ address, allowed });
  }
});

test('a tunnel follows the mode: open allows, none refuses, box checks the list', () => {
  const box = { mode: 'box', allow: ['github.com', '172.17.0.1'] } as const;

  expect(isTunnelAllowed({ mode: 'open', allow: [] }, 'example.org')).toBeTrue();
  expect(isTunnelAllowed({ mode: 'none', allow: [] }, 'github.com')).toBeFalse();
  expect(isTunnelAllowed(box, 'github.com')).toBeTrue();
  expect(isTunnelAllowed(box, '172.17.0.1')).toBeTrue();
  expect(isTunnelAllowed(box, 'example.org')).toBeFalse();
});

test('only the exact names can be resolved ahead of the guest', () => {
  expect(listExactNames(['github.com', '*.npmjs.org', '9.9.9.9'])).toEqual(['github.com']);
});
