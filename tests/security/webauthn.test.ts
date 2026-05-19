/**
 * tests/security/webauthn.test.ts
 *
 * v0.7 Phase 1 — coverage for the WebAuthn coordinator's pending-challenge
 * state machine + the round-trip with the identity store. We mock the
 * cryptographic verification calls in @simplewebauthn/server so the tests
 * don't need a real authenticator — full integration with a virtual
 * authenticator lives in Phase 10a.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { EventStore } from '../../src/persistence.js';
import { IdentityStore } from '../../src/security/identity-store.js';
import { WebAuthnCoordinator, WebAuthnCeremonyError } from '../../src/security/webauthn.js';

vi.mock('@simplewebauthn/server', () => {
  let nextChallenge = 'challenge-default';
  return {
    __setNextChallenge: (c: string) => {
      nextChallenge = c;
    },
    generateRegistrationOptions: vi.fn(async () => ({
      challenge: nextChallenge,
      rp: { id: 'localhost', name: 'stavR' },
      user: { id: 'op', name: 'operator', displayName: 'operator' },
      pubKeyCredParams: [],
      excludeCredentials: [],
    })),
    verifyRegistrationResponse: vi.fn(async () => ({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'mock-cred-id',
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
        },
      },
    })),
    generateAuthenticationOptions: vi.fn(async () => ({
      challenge: nextChallenge,
      rpId: 'localhost',
      allowCredentials: [],
    })),
    verifyAuthenticationResponse: vi.fn(async () => ({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    })),
  };
});

// Helper to set the challenge the mocked option-generators will return.
async function setNextChallenge(c: string): Promise<void> {
  const mod = (await import('@simplewebauthn/server')) as unknown as {
    __setNextChallenge: (c: string) => void;
  };
  mod.__setNextChallenge(c);
}

function clientDataB64(challenge: string): string {
  return Buffer.from(JSON.stringify({ challenge, type: 'webauthn.create', origin: 'http://localhost' }), 'utf8').toString('base64');
}

describe('WebAuthnCoordinator', () => {
  let eventStore: EventStore;
  let identity: IdentityStore;
  let coord: WebAuthnCoordinator;

  beforeEach(() => {
    eventStore = new EventStore();
    eventStore.init(':memory:');
    identity = new IdentityStore(eventStore.rawDb);
    coord = new WebAuthnCoordinator(identity, {
      rpId: 'localhost',
      rpName: 'stavR-test',
      expectedOrigins: ['http://localhost'],
    });
  });

  afterEach(() => {
    coord.dispose();
    eventStore.close();
  });

  it('beginRegistration() returns options with the challenge', async () => {
    await setNextChallenge('reg-1');
    const opts = await coord.beginRegistration({
      operatorId: 'operator',
      operatorDisplayName: 'Kenneth',
    });
    expect(opts.challenge).toBe('reg-1');
  });

  it('finishRegistration() persists the credential and clears the pending challenge', async () => {
    await setNextChallenge('reg-2');
    await coord.beginRegistration({
      operatorId: 'operator',
      operatorDisplayName: 'Kenneth',
    });
    const cred = await coord.finishRegistration({
      operatorId: 'operator',
      response: {
        id: 'mock-cred-id',
        rawId: 'mock-cred-id',
        type: 'public-key',
        response: {
          attestationObject: '',
          clientDataJSON: clientDataB64('reg-2'),
          transports: ['internal'],
        },
        clientExtensionResults: {},
      } as unknown as Parameters<WebAuthnCoordinator['finishRegistration']>[0]['response'],
      deviceLabel: 'Yubikey',
    });
    expect(cred.credential_id).toBe('mock-cred-id');
    expect(cred.device_label).toBe('Yubikey');
    expect(identity.getById('mock-cred-id')).toBeDefined();

    // Replaying the same response now fails — the challenge is consumed.
    await expect(
      coord.finishRegistration({
        operatorId: 'operator',
        response: {
          id: 'mock-cred-id',
          rawId: 'mock-cred-id',
          type: 'public-key',
          response: {
            attestationObject: '',
            clientDataJSON: clientDataB64('reg-2'),
            transports: ['internal'],
          },
          clientExtensionResults: {},
        } as unknown as Parameters<WebAuthnCoordinator['finishRegistration']>[0]['response'],
      }),
    ).rejects.toThrow(WebAuthnCeremonyError);
  });

  it('finishRegistration() rejects on operator mismatch', async () => {
    await setNextChallenge('reg-3');
    await coord.beginRegistration({ operatorId: 'kenneth', operatorDisplayName: 'K' });
    await expect(
      coord.finishRegistration({
        operatorId: 'son',
        response: {
          id: 'mock-cred-id',
          rawId: 'mock-cred-id',
          type: 'public-key',
          response: {
            attestationObject: '',
            clientDataJSON: clientDataB64('reg-3'),
            transports: ['internal'],
          },
          clientExtensionResults: {},
        } as unknown as Parameters<WebAuthnCoordinator['finishRegistration']>[0]['response'],
      }),
    ).rejects.toThrow(/operator mismatch/);
  });

  it('beginAuthentication() throws when operator has no credentials', async () => {
    await expect(
      coord.beginAuthentication({ operatorId: 'nobody' }),
    ).rejects.toThrow(/no registered credentials/);
  });

  it('full registration + authentication round-trip records a tier3 assertion', async () => {
    // Register
    await setNextChallenge('reg-4');
    await coord.beginRegistration({ operatorId: 'operator', operatorDisplayName: 'op' });
    await coord.finishRegistration({
      operatorId: 'operator',
      response: {
        id: 'mock-cred-id',
        rawId: 'mock-cred-id',
        type: 'public-key',
        response: {
          attestationObject: '',
          clientDataJSON: clientDataB64('reg-4'),
          transports: ['internal'],
        },
        clientExtensionResults: {},
      } as unknown as Parameters<WebAuthnCoordinator['finishRegistration']>[0]['response'],
    });

    // Authenticate
    await setNextChallenge('auth-4');
    await coord.beginAuthentication({
      operatorId: 'operator',
      correlationId: 'cid-decision-X',
      scopeLabel: 'force-push',
    });
    const result = await coord.finishAuthentication({
      operatorId: 'operator',
      response: {
        id: 'mock-cred-id',
        rawId: 'mock-cred-id',
        type: 'public-key',
        response: {
          authenticatorData: '',
          clientDataJSON: clientDataB64('auth-4'),
          signature: '',
        },
        clientExtensionResults: {},
      } as unknown as Parameters<WebAuthnCoordinator['finishAuthentication']>[0]['response'],
      assertionTtlMs: 30_000,
    });
    expect(result.credentialId).toBe('mock-cred-id');
    expect(result.expiresAt).toBeGreaterThan(Date.now());

    // The assertion is now discoverable via identity-store within the window.
    const fresh = identity.hasRecentAssertion({
      operatorId: 'operator',
      correlationId: 'cid-decision-X',
    });
    expect(fresh?.id).toBe(result.assertionId);
    expect(fresh?.scope_label).toBe('force-push');

    // Counter was advanced.
    const cred = identity.getById('mock-cred-id')!;
    expect(cred.counter).toBe(1);
    expect(cred.last_used_at).toBeGreaterThan(0);
  });

  it('finishAuthentication() rejects a revoked credential', async () => {
    await setNextChallenge('reg-5');
    await coord.beginRegistration({ operatorId: 'operator', operatorDisplayName: 'op' });
    await coord.finishRegistration({
      operatorId: 'operator',
      response: {
        id: 'mock-cred-id',
        rawId: 'mock-cred-id',
        type: 'public-key',
        response: {
          attestationObject: '',
          clientDataJSON: clientDataB64('reg-5'),
          transports: ['internal'],
        },
        clientExtensionResults: {},
      } as unknown as Parameters<WebAuthnCoordinator['finishRegistration']>[0]['response'],
    });
    identity.revoke('mock-cred-id');

    await setNextChallenge('auth-5');
    // beginAuthentication will fail because operator has no active creds.
    await expect(
      coord.beginAuthentication({ operatorId: 'operator' }),
    ).rejects.toThrow(/no registered credentials/);
  });

  it('consumeChallenge() rejects when no pending challenge matches', async () => {
    await expect(
      coord.finishRegistration({
        operatorId: 'operator',
        response: {
          id: 'x',
          rawId: 'x',
          type: 'public-key',
          response: {
            attestationObject: '',
            clientDataJSON: clientDataB64('unknown-challenge'),
            transports: ['internal'],
          },
          clientExtensionResults: {},
        } as unknown as Parameters<WebAuthnCoordinator['finishRegistration']>[0]['response'],
      }),
    ).rejects.toThrow(/no pending challenge/);
  });
});
