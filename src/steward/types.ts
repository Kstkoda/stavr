// Spec 48 Layer 1 — Steward role types.

export interface StewardRecord {
  id: string;
  client_id: string;
  user_id: string;
  display_name?: string;
  model?: string;
  provider?: string;
  claimed_at: string;
  released_at?: string;
  last_pulse_at?: string;
  memory_path?: string;
  metadata: Record<string, unknown>;
}

export interface StewardClaimToken {
  token: string;
  created_at: string;
  expires_at: string;
  redeemed_at?: string;
  redeemed_by?: string;
}

export interface StewardClaimInput {
  client_id: string;
  user_id: string;
  display_name?: string;
  model?: string;
  provider?: string;
  metadata?: Record<string, unknown>;
}

export class StewardAlreadyClaimedError extends Error {
  code = 'STEWARD_ALREADY_CLAIMED' as const;
  constructor(public active: StewardRecord) {
    super(
      `An active Steward already holds the role: ${active.display_name ?? active.client_id} ` +
        `(claimed_at ${active.claimed_at}). Release or transfer before claiming again.`,
    );
  }
}

export class StewardTokenInvalidError extends Error {
  code = 'STEWARD_TOKEN_INVALID' as const;
  constructor(reason: 'unknown' | 'expired' | 'already_redeemed') {
    super(`steward claim token is ${reason}`);
  }
}

export class NoActiveStewardError extends Error {
  code = 'NO_ACTIVE_STEWARD' as const;
  constructor() {
    super('no active Steward session');
  }
}
