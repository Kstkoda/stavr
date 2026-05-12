export interface ActionMatcher {
  tool: string;
  param_constraints?: Record<string, unknown>;
  reason?: string;
}

export type ScopeCadence =
  | 'every-action'
  | 'every-5-actions'
  | 'every-15-min'
  | 'on-completion-only';

export type ScopeChannel = 'chat' | 'event-log' | 'dashboard' | 'slack' | 'email';

export interface ScopeReporting {
  cadence: ScopeCadence;
  channels: ScopeChannel[];
}

export type TrustScopeStatus = 'proposed' | 'active' | 'expired' | 'revoked' | 'completed';

export interface TrustScope {
  id: string;
  title: string;
  description: string;
  granted_by: string;
  granted_at: string;
  expires_at: string;
  expires_after_actions?: number;
  allowed_actions: ActionMatcher[];
  forbidden_actions?: ActionMatcher[];
  reporting: ScopeReporting;
  status: TrustScopeStatus;
  spec_url?: string;
  proposed_at?: string;
  actions_executed: number;
  completed_at?: string;
}

export interface ScopeActionRecord {
  id: string;
  scope_id: string;
  tool_name: string;
  args: unknown;
  result: unknown;
  executed_at: string;
}

export interface ProposeInput {
  title: string;
  description: string;
  allowed_actions: ActionMatcher[];
  forbidden_actions?: ActionMatcher[];
  reporting?: ScopeReporting;
  expires_at?: string;
  expires_after_actions?: number;
  spec_url?: string;
}
