import { describe, expect, it, beforeEach } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { StewardStore } from '../../src/steward/store.js';
import {
  NoActiveStewardError,
  StewardAlreadyClaimedError,
  StewardTokenInvalidError,
} from '../../src/steward/types.js';

function freshStore(): StewardStore {
  const events = new EventStore();
  events.init(':memory:');
  return new StewardStore(events);
}

describe('Spec 48 Layer 1 — Steward claim lifecycle', () => {
  let store: StewardStore;
  beforeEach(() => {
    store = freshStore();
  });

  it('first claim succeeds, second simultaneous claim throws StewardAlreadyClaimedError', () => {
    const t1 = store.mintClaimToken();
    const t2 = store.mintClaimToken();
    const first = store.claim(t1.token, {
      client_id: 'cowork-chat-1',
      user_id: 'kenneth',
      display_name: 'Co',
    });
    expect(first.released_at).toBeUndefined();
    expect(store.getActiveSteward()?.id).toBe(first.id);

    expect(() =>
      store.claim(t2.token, { client_id: 'rogue-client', user_id: 'kenneth' }),
    ).toThrow(StewardAlreadyClaimedError);

    // Rejected claim must not redeem its token, so the User can retry after
    // releasing the active Steward.
    const active = store.getActiveSteward();
    expect(active?.client_id).toBe('cowork-chat-1');
  });

  it('release ends the session and lets a new client claim with a fresh token', () => {
    const t1 = store.mintClaimToken();
    const first = store.claim(t1.token, { client_id: 'cowork-chat-1', user_id: 'kenneth' });
    const released = store.release('shift change');
    expect(released.id).toBe(first.id);
    expect(released.released_at).toBeDefined();
    expect(released.metadata.release_reason).toBe('shift change');
    expect(store.getActiveSteward()).toBeUndefined();

    const t2 = store.mintClaimToken();
    const second = store.claim(t2.token, {
      client_id: 'cowork-chat-2',
      user_id: 'kenneth',
    });
    expect(second.id).not.toBe(first.id);
    expect(store.getActiveSteward()?.id).toBe(second.id);
  });

  it('release with no active Steward throws NoActiveStewardError', () => {
    expect(() => store.release()).toThrow(NoActiveStewardError);
  });

  it('transfer atomically releases the old Steward and claims for the new client', () => {
    const t1 = store.mintClaimToken();
    const first = store.claim(t1.token, {
      client_id: 'cowork-chat-old',
      user_id: 'kenneth',
    });
    const t2 = store.mintClaimToken();
    const { from, to } = store.transfer(t2.token, {
      client_id: 'cowork-chat-new',
      user_id: 'kenneth',
      display_name: 'Co (handed off)',
    });
    expect(from.id).toBe(first.id);
    expect(from.released_at).toBeDefined();
    expect(to.id).not.toBe(first.id);
    expect(to.released_at).toBeUndefined();
    const active = store.getActiveSteward();
    expect(active?.id).toBe(to.id);
    expect(active?.client_id).toBe('cowork-chat-new');
  });

  it('expired token is rejected even when no Steward is active', () => {
    // Mint a token with a 1ms TTL — by the time we attempt to redeem it the
    // expiry has already passed. Avoids real time waits in unit tests.
    const t = store.mintClaimToken({ ttlMs: 1 });
    // Sub-millisecond busy wait to ensure Date.now() advances past expires_at.
    const deadline = new Date(t.expires_at).getTime() + 2;
    while (Date.now() <= deadline) {
      /* spin */
    }
    expect(() => store.claim(t.token, { client_id: 'late', user_id: 'kenneth' })).toThrow(
      StewardTokenInvalidError,
    );
  });

  it('already-redeemed token is rejected on second use', () => {
    const t = store.mintClaimToken();
    store.claim(t.token, { client_id: 'first', user_id: 'kenneth' });
    store.release();
    expect(() => store.claim(t.token, { client_id: 'reuser', user_id: 'kenneth' })).toThrow(
      StewardTokenInvalidError,
    );
  });

  it('unknown token is rejected', () => {
    expect(() =>
      store.claim('sct-does-not-exist', { client_id: 'x', user_id: 'kenneth' }),
    ).toThrow(StewardTokenInvalidError);
  });

  it('recordPulse updates last_pulse_at on the active Steward only', () => {
    const t = store.mintClaimToken();
    const rec = store.claim(t.token, { client_id: 'c1', user_id: 'kenneth' });
    const beforePulse = rec.last_pulse_at;
    // Tiny spin so the new timestamp differs from the claim's last_pulse_at.
    const start = Date.now();
    while (Date.now() - start < 2) {
      /* spin */
    }
    const after = store.recordPulse();
    expect(after?.last_pulse_at).toBeDefined();
    expect(after?.last_pulse_at).not.toBe(beforePulse);
  });
});
