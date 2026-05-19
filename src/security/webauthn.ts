/**
 * WebAuthn / passkey ceremonies — ADR-042 §Decision 3 v0.7 (Option A).
 *
 * Tier 3 EXPLICIT actions require a verified passkey assertion from the
 * operator within a short window. This module wraps `@simplewebauthn/server`
 * to provide:
 *
 *   - `generateRegistrationCeremony()` — builds the options blob the browser
 *     hands to `navigator.credentials.create()`
 *   - `verifyRegistration()` — validates the attestation response and
 *     persists the credential
 *   - `generateAuthenticationCeremony()` — builds the options blob for
 *     `navigator.credentials.get()`
 *   - `verifyAuthentication()` — validates the assertion response and
 *     advances the credential counter
 *
 * The "RP" (relying party) is stavR itself — local-loopback by default. RP
 * id defaults to `localhost` for loopback installs, but operator can
 * override via STAVR_WEBAUTHN_RP_ID for LAN / family-federation deployments
 * where peers reach the dashboard via the host's mDNS name.
 *
 * Per-decision cross-link to Decision 3 v1.0: the registered credential's
 * COSE public key becomes the BIP32-Ed25519 derivation root in v1.0. We
 * store the COSE bytes verbatim today so the v1.0 layer doesn't have to
 * re-register every credential.
 */
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type GenerateRegistrationOptionsOpts,
  type GenerateAuthenticationOptionsOpts,
  type VerifyRegistrationResponseOpts,
  type VerifyAuthenticationResponseOpts,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import type { IdentityStore, RegisteredCredential } from './identity-store.js';

/** Tier 3 assertion freshness window default. Per BOM Phase 1: "within last 60s". */
export const DEFAULT_TIER3_ASSERTION_TTL_MS = 60_000;

/** Long-poll challenge TTL — the operator has this long to complete the
 *  ceremony from the moment the browser receives the options blob. 5 min
 *  is plenty for a biometric prompt; longer and the challenge is stale. */
export const CEREMONY_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Per-process pending-challenge registry. The challenge is the
 *  cryptographic nonce — we generate it server-side, hand it to the
 *  browser, and require it back in the assertion. Pending challenges
 *  live in memory and expire on daemon restart, which is the correct
 *  security posture (a restart forces re-auth, never silently rotates). */
interface PendingChallenge {
  challenge: string;
  operatorId: string;
  kind: 'registration' | 'authentication';
  correlationId?: string;
  scopeLabel?: string;
  expires_at: number;
}

export class WebAuthnCeremonyError extends Error {
  readonly code = 'webauthn_ceremony_error' as const;
  constructor(public readonly stage: string, message: string) {
    super(`[webauthn:${stage}] ${message}`);
  }
}

export interface WebAuthnConfig {
  /** RP id — defaults to STAVR_WEBAUTHN_RP_ID or 'localhost'. Lower-case. */
  rpId: string;
  /** RP name shown in the browser's passkey prompt. */
  rpName: string;
  /** Acceptable origins for assertions. Defaults to derived from rpId
   *  with both http and https loopback ports stavR commonly binds to. */
  expectedOrigins: string[];
}

export function defaultConfig(): WebAuthnConfig {
  const rpId = (process.env['STAVR_WEBAUTHN_RP_ID'] ?? 'localhost').toLowerCase();
  const rpName = process.env['STAVR_WEBAUTHN_RP_NAME'] ?? 'stavR';
  const envOrigins = process.env['STAVR_WEBAUTHN_ORIGINS'];
  const expectedOrigins = envOrigins
    ? envOrigins.split(',').map((s) => s.trim()).filter(Boolean)
    : [
        `http://${rpId}`,
        `https://${rpId}`,
        `http://${rpId}:7777`,
        `http://${rpId}:7778`,
        `http://${rpId}:8080`,
      ];
  return { rpId, rpName, expectedOrigins };
}

export class WebAuthnCoordinator {
  private readonly pending = new Map<string, PendingChallenge>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly identity: IdentityStore,
    private readonly config: WebAuthnConfig = defaultConfig(),
  ) {
    // Hourly sweep of expired challenges. Bounded one-shot per ADR-012.
    this.cleanupTimer = setInterval(() => this.sweepExpired(), 60_000);
    if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref();
  }

  /** For tests: stop the sweeper so processes can exit cleanly. */
  dispose(): void {
    clearInterval(this.cleanupTimer);
  }

  config_(): WebAuthnConfig {
    return this.config;
  }

  /** Step 1 of registration. Returns the options blob to send the browser. */
  async beginRegistration(opts: {
    operatorId: string;
    operatorDisplayName: string;
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const existing = this.identity.listForOperator(opts.operatorId, { includeRevoked: false });
    const excludeCredentials = existing.map((c) => ({
      id: c.credential_id,
      type: 'public-key' as const,
      transports: c.transports as AuthenticatorTransportFuture[],
    }));
    const optionsInput: GenerateRegistrationOptionsOpts = {
      rpName: this.config.rpName,
      rpID: this.config.rpId,
      userID: Buffer.from(opts.operatorId, 'utf8'),
      userName: opts.operatorId,
      userDisplayName: opts.operatorDisplayName,
      timeout: CEREMONY_CHALLENGE_TTL_MS,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
      excludeCredentials,
    };
    const options = await generateRegistrationOptions(optionsInput);
    this.pending.set(options.challenge, {
      challenge: options.challenge,
      operatorId: opts.operatorId,
      kind: 'registration',
      expires_at: Date.now() + CEREMONY_CHALLENGE_TTL_MS,
    });
    return options;
  }

  /** Step 2 of registration. Validates the attestation and persists the
   *  credential. Returns the stored row (caller can echo its public_id /
   *  device_label to the dashboard UI). */
  async finishRegistration(opts: {
    operatorId: string;
    response: RegistrationResponseJSON;
    deviceLabel?: string;
  }): Promise<RegisteredCredential> {
    const pending = this.consumeChallenge(opts.response.response.clientDataJSON);
    if (pending.kind !== 'registration') {
      throw new WebAuthnCeremonyError('finishRegistration', 'pending challenge is not a registration');
    }
    if (pending.operatorId !== opts.operatorId) {
      throw new WebAuthnCeremonyError('finishRegistration', 'operator mismatch');
    }
    const verifyInput: VerifyRegistrationResponseOpts = {
      response: opts.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: this.config.expectedOrigins,
      expectedRPID: this.config.rpId,
      requireUserVerification: false,
    };
    let verification: VerifiedRegistrationResponse;
    try {
      verification = await verifyRegistrationResponse(verifyInput);
    } catch (err) {
      throw new WebAuthnCeremonyError(
        'finishRegistration',
        `attestation verification failed: ${(err as Error).message}`,
      );
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new WebAuthnCeremonyError('finishRegistration', 'attestation rejected');
    }
    const info = verification.registrationInfo;
    const credential = info.credential;
    const transports = opts.response.response.transports ?? [];
    return this.identity.register({
      credentialId: credential.id,
      operatorId: opts.operatorId,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports,
      ...(opts.deviceLabel !== undefined ? { deviceLabel: opts.deviceLabel } : {}),
    });
  }

  /** Step 1 of authentication (assertion). Returns the options blob. */
  async beginAuthentication(opts: {
    operatorId: string;
    correlationId?: string;
    scopeLabel?: string;
  }): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const credentials = this.identity.listForOperator(opts.operatorId, { includeRevoked: false });
    if (credentials.length === 0) {
      throw new WebAuthnCeremonyError(
        'beginAuthentication',
        `no registered credentials for operator "${opts.operatorId}"`,
      );
    }
    const optionsInput: GenerateAuthenticationOptionsOpts = {
      rpID: this.config.rpId,
      timeout: CEREMONY_CHALLENGE_TTL_MS,
      userVerification: 'preferred',
      allowCredentials: credentials.map((c) => ({
        id: c.credential_id,
        type: 'public-key' as const,
        transports: c.transports as AuthenticatorTransportFuture[],
      })),
    };
    const options = await generateAuthenticationOptions(optionsInput);
    this.pending.set(options.challenge, {
      challenge: options.challenge,
      operatorId: opts.operatorId,
      kind: 'authentication',
      ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
      ...(opts.scopeLabel !== undefined ? { scopeLabel: opts.scopeLabel } : {}),
      expires_at: Date.now() + CEREMONY_CHALLENGE_TTL_MS,
    });
    return options;
  }

  /** Step 2 of authentication. Validates the assertion, advances the
   *  credential counter, and writes a tier3_assertions row that subsequent
   *  freshness checks will read. */
  async finishAuthentication(opts: {
    operatorId: string;
    response: AuthenticationResponseJSON;
    assertionTtlMs?: number;
  }): Promise<{ assertionId: string; credentialId: string; expiresAt: number }> {
    const pending = this.consumeChallenge(opts.response.response.clientDataJSON);
    if (pending.kind !== 'authentication') {
      throw new WebAuthnCeremonyError('finishAuthentication', 'pending challenge is not an authentication');
    }
    if (pending.operatorId !== opts.operatorId) {
      throw new WebAuthnCeremonyError('finishAuthentication', 'operator mismatch');
    }
    const credential = this.identity.getById(opts.response.id);
    if (!credential || credential.revoked_at !== null) {
      throw new WebAuthnCeremonyError('finishAuthentication', 'credential not registered or revoked');
    }
    const verifyInput: VerifyAuthenticationResponseOpts = {
      response: opts.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: this.config.expectedOrigins,
      expectedRPID: this.config.rpId,
      credential: {
        id: credential.credential_id,
        publicKey: new Uint8Array(credential.public_key),
        counter: credential.counter,
        transports: credential.transports as AuthenticatorTransportFuture[],
      },
      requireUserVerification: false,
    };
    let verification: VerifiedAuthenticationResponse;
    try {
      verification = await verifyAuthenticationResponse(verifyInput);
    } catch (err) {
      throw new WebAuthnCeremonyError(
        'finishAuthentication',
        `assertion verification failed: ${(err as Error).message}`,
      );
    }
    if (!verification.verified) {
      throw new WebAuthnCeremonyError('finishAuthentication', 'assertion rejected');
    }
    this.identity.updateCounter(credential.credential_id, verification.authenticationInfo.newCounter);
    const ttl = opts.assertionTtlMs ?? DEFAULT_TIER3_ASSERTION_TTL_MS;
    const assertionId = randomBytes(16).toString('hex');
    const now = Date.now();
    this.identity.recordAssertion({
      id: assertionId,
      operatorId: opts.operatorId,
      credentialId: credential.credential_id,
      ...(pending.correlationId !== undefined ? { correlationId: pending.correlationId } : {}),
      ...(pending.scopeLabel !== undefined ? { scopeLabel: pending.scopeLabel } : {}),
      createdAt: now,
      expiresAt: now + ttl,
    });
    return { assertionId, credentialId: credential.credential_id, expiresAt: now + ttl };
  }

  /** Reads the challenge from the response's clientDataJSON without
   *  trusting the browser to send it verbatim. simplewebauthn-server
   *  ALSO validates that the challenge matches; we use the look-up to
   *  find our pending record. */
  private consumeChallenge(clientDataJsonB64: string): PendingChallenge {
    const json = JSON.parse(Buffer.from(clientDataJsonB64, 'base64').toString('utf8')) as {
      challenge: string;
    };
    const pending = this.pending.get(json.challenge);
    if (!pending) {
      throw new WebAuthnCeremonyError('consumeChallenge', 'no pending challenge for response');
    }
    if (Date.now() > pending.expires_at) {
      this.pending.delete(json.challenge);
      throw new WebAuthnCeremonyError('consumeChallenge', 'pending challenge expired');
    }
    this.pending.delete(json.challenge);
    return pending;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, pending] of this.pending.entries()) {
      if (pending.expires_at < now) this.pending.delete(key);
    }
  }
}
