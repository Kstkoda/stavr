/**
 * HTTP endpoints for the WebAuthn / passkey ceremony — v0.7 Phase 1.
 *
 * Mounted by transports.ts under `/api/auth/*`. Loopback-only when the
 * daemon is bound to 127.0.0.1; LAN-accessible when bound to a broader
 * interface (operator's call — affected by the same `bind_host` knob as
 * the rest of the HTTP surface).
 *
 * Routes:
 *   POST /api/auth/register/options    — begin registration ceremony
 *   POST /api/auth/register/verify     — finish registration ceremony
 *   POST /api/auth/assert/options      — begin authentication ceremony
 *   POST /api/auth/assert/verify       — finish authentication ceremony
 *   GET  /api/auth/credentials         — list operator's credentials
 *   POST /api/auth/credentials/:id/revoke — revoke one
 *   GET  /api/auth/tier3/recent        — has the operator recently asserted?
 *
 * The operator identifier comes from the `X-Stavr-Operator` header when
 * set; otherwise defaults to 'operator' (single-operator personal stavR
 * is the standing assumption). This matches the actor model in
 * `src/security/actor-permissions.ts`.
 */
import type { Express, Request, Response } from 'express';
import { WebAuthnCeremonyError, type WebAuthnCoordinator } from './webauthn.js';
import type { IdentityStore, RegisteredCredential } from './identity-store.js';

export interface MountOptions {
  /** Returns the per-process WebAuthn coordinator. */
  getCoordinator: () => WebAuthnCoordinator;
  /** Returns the identity store (for list / revoke / recent endpoints). */
  getIdentityStore: () => IdentityStore;
}

const DEFAULT_OPERATOR = 'operator';

export function mountWebAuthnRoutes(app: Express, opts: MountOptions): void {
  const operatorIdFrom = (req: Request): string => {
    const raw = req.header('x-stavr-operator');
    if (!raw || !raw.trim()) return DEFAULT_OPERATOR;
    return raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64);
  };

  app.post('/api/auth/register/options', async (req: Request, res: Response) => {
    try {
      const operatorId = operatorIdFrom(req);
      const displayName = typeof req.body?.displayName === 'string' && req.body.displayName.length > 0
        ? req.body.displayName
        : operatorId;
      const options = await opts.getCoordinator().beginRegistration({
        operatorId,
        operatorDisplayName: displayName,
      });
      res.json(options);
    } catch (err) {
      respondError(res, err);
    }
  });

  app.post('/api/auth/register/verify', async (req: Request, res: Response) => {
    try {
      const operatorId = operatorIdFrom(req);
      const response = req.body?.response;
      if (!response) {
        res.status(400).json({ error: 'response field required' });
        return;
      }
      const deviceLabel =
        typeof req.body?.deviceLabel === 'string' && req.body.deviceLabel.length > 0
          ? req.body.deviceLabel
          : undefined;
      const credential = await opts.getCoordinator().finishRegistration({
        operatorId,
        response,
        ...(deviceLabel !== undefined ? { deviceLabel } : {}),
      });
      res.json({
        ok: true,
        credential: redactCredential(credential),
      });
    } catch (err) {
      respondError(res, err);
    }
  });

  app.post('/api/auth/assert/options', async (req: Request, res: Response) => {
    try {
      const operatorId = operatorIdFrom(req);
      const correlationId =
        typeof req.body?.correlationId === 'string' && req.body.correlationId.length > 0
          ? req.body.correlationId
          : undefined;
      const scopeLabel =
        typeof req.body?.scopeLabel === 'string' && req.body.scopeLabel.length > 0
          ? req.body.scopeLabel
          : undefined;
      const options = await opts.getCoordinator().beginAuthentication({
        operatorId,
        ...(correlationId !== undefined ? { correlationId } : {}),
        ...(scopeLabel !== undefined ? { scopeLabel } : {}),
      });
      res.json(options);
    } catch (err) {
      respondError(res, err);
    }
  });

  app.post('/api/auth/assert/verify', async (req: Request, res: Response) => {
    try {
      const operatorId = operatorIdFrom(req);
      const response = req.body?.response;
      if (!response) {
        res.status(400).json({ error: 'response field required' });
        return;
      }
      const ttlMs =
        typeof req.body?.assertionTtlMs === 'number' && req.body.assertionTtlMs > 0
          ? Math.min(req.body.assertionTtlMs, 5 * 60 * 1000)
          : undefined;
      const result = await opts.getCoordinator().finishAuthentication({
        operatorId,
        response,
        ...(ttlMs !== undefined ? { assertionTtlMs: ttlMs } : {}),
      });
      res.json({
        ok: true,
        assertion_id: result.assertionId,
        credential_id: result.credentialId,
        expires_at: result.expiresAt,
      });
    } catch (err) {
      respondError(res, err);
    }
  });

  app.get('/api/auth/credentials', (req: Request, res: Response) => {
    try {
      const operatorId = operatorIdFrom(req);
      const list = opts.getIdentityStore().listForOperator(operatorId, { includeRevoked: false });
      res.json({
        operator_id: operatorId,
        credentials: list.map(redactCredential),
      });
    } catch (err) {
      respondError(res, err);
    }
  });

  app.post('/api/auth/credentials/:id/revoke', (req: Request, res: Response) => {
    try {
      const operatorId = operatorIdFrom(req);
      const credId = req.params['id'];
      if (!credId) {
        res.status(400).json({ error: 'credential id required' });
        return;
      }
      const cred = opts.getIdentityStore().getById(credId);
      if (!cred) {
        res.status(404).json({ error: 'credential not found' });
        return;
      }
      if (cred.operator_id !== operatorId) {
        // Don't reveal cross-operator credential existence — 404 keeps the
        // probe-safe response surface.
        res.status(404).json({ error: 'credential not found' });
        return;
      }
      opts.getIdentityStore().revoke(credId);
      res.json({ ok: true });
    } catch (err) {
      respondError(res, err);
    }
  });

  app.get('/api/auth/tier3/recent', (req: Request, res: Response) => {
    try {
      const operatorId = operatorIdFrom(req);
      const correlationId = typeof req.query['correlation_id'] === 'string'
        ? req.query['correlation_id']
        : undefined;
      const assertion = opts.getIdentityStore().hasRecentAssertion({
        operatorId,
        ...(correlationId !== undefined ? { correlationId } : {}),
      });
      res.json({
        operator_id: operatorId,
        has_recent: assertion !== undefined,
        assertion: assertion
          ? {
              created_at: assertion.created_at,
              expires_at: assertion.expires_at,
              correlation_id: assertion.correlation_id,
              scope_label: assertion.scope_label,
            }
          : null,
      });
    } catch (err) {
      respondError(res, err);
    }
  });
}

/** Trim a credential for HTTP responses — the public_key bytes are not
 *  useful to the dashboard UI and should not be exposed gratuitously. */
function redactCredential(c: RegisteredCredential): Record<string, unknown> {
  return {
    credential_id: c.credential_id,
    operator_id: c.operator_id,
    device_label: c.device_label,
    transports: c.transports,
    registered_at: c.registered_at,
    last_used_at: c.last_used_at,
    revoked_at: c.revoked_at,
  };
}

function respondError(res: Response, err: unknown): void {
  if (err instanceof WebAuthnCeremonyError) {
    res.status(400).json({ error: err.message, stage: err.stage });
    return;
  }
  const message = err instanceof Error ? err.message : 'webauthn route failed';
  res.status(500).json({ error: message });
}
