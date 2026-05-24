// Bombardment Phase 3d — federation oracle registry.
//
// Two sets:
//   - defaultFederationOracles() — read-only, safe to run continuously.
//     These are what the CI workflow's "run federation oracles" step
//     invokes after the topology is healthy.
//   - destructiveFederationOracles() — mutate the topology (docker
//     pause/unpause, future docker kill/restart). Only invoked by
//     dedicated slice runners (run-recovery-slice.mjs, future Phase 4
//     chaos slices).

import { mutualVisibility } from './mutual-visibility.mjs';
import { peerStateConvergence } from './peer-state-convergence.mjs';
import { identityPropagation } from './identity-propagation.mjs';
import { peerUnreachableRecovery } from './peer-unreachable-recovery.mjs';

export function defaultFederationOracles() {
  return [mutualVisibility, peerStateConvergence, identityPropagation];
}

export function destructiveFederationOracles() {
  return [peerUnreachableRecovery];
}

export {
  mutualVisibility,
  peerStateConvergence,
  identityPropagation,
  peerUnreachableRecovery,
};
