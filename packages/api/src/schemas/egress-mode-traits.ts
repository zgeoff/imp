import type { EgressMode } from './egress-schema';

// What each egress mode means to the code that acts on it
// (docs/architecture/network/egress.md); nothing else compares a mode.
export interface EgressModeTraits {
  // reaches anything but link-local and the tailnet, and asks its own DNS
  readonly isOpen: boolean;

  // only a firewall that impd enforces keeps it to its mode, and impd's
  // resolver answers its DNS
  readonly needsRuleset: boolean;

  // reaches the internet only, by the host's uplinks
  readonly isPublic: boolean;

  // reaches only what its allow-list names
  readonly hasAllowList: boolean;
}

export const EGRESS_MODE_TRAITS: Readonly<Record<EgressMode, EgressModeTraits>> = {
  open: { isOpen: true, needsRuleset: false, isPublic: false, hasAllowList: false },
  public: { isOpen: false, needsRuleset: true, isPublic: true, hasAllowList: false },
  box: { isOpen: false, needsRuleset: true, isPublic: false, hasAllowList: true },
  none: { isOpen: false, needsRuleset: true, isPublic: false, hasAllowList: false },
};
