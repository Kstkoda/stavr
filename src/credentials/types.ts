// Spec 48 Layer 2 — Credential vault types.

export type CredentialKind = 'oauth' | 'api_key' | 'local_ref';

export interface CredentialRecord {
  id: string;
  user_id: string;
  service: string;
  kind: CredentialKind;
  /** Only populated when the caller explicitly opts in (e.g. internal vault `credentialUse`). */
  plaintext?: string;
  oauth_scopes?: string[];
  /** Only populated when the caller explicitly opts in. */
  oauth_refresh_token?: string;
  expires_at?: string;
  created_at: string;
  last_used_at?: string;
  revoked_at?: string;
  metadata: Record<string, unknown>;
}

export interface CredentialGrantRecord {
  id: string;
  credential_id: string;
  steward_session_id?: string;
  granted_at: string;
  revoked_at?: string;
  granted_by_user_id: string;
  uses_remaining?: number;
  expires_at?: string;
}

export interface AddCredentialInput {
  user_id: string;
  service: string;
  kind: CredentialKind;
  /** Plaintext secret (api_key or oauth access token). Encrypted before disk. */
  plaintext?: string;
  oauth_refresh_token?: string;
  oauth_scopes?: string[];
  expires_at?: string;
  metadata?: Record<string, unknown>;
}

export class CredentialNotFoundError extends Error {
  code = 'CREDENTIAL_NOT_FOUND' as const;
  constructor(public credential_id: string) {
    super(`credential ${credential_id} not found`);
  }
}

export class CredentialRevokedError extends Error {
  code = 'CREDENTIAL_REVOKED' as const;
  constructor(public credential_id: string) {
    super(`credential ${credential_id} is revoked`);
  }
}

export class CredentialNotGrantedError extends Error {
  code = 'CREDENTIAL_NOT_GRANTED' as const;
  constructor(public credential_id: string) {
    super(`no active grant exists for credential ${credential_id}`);
  }
}
