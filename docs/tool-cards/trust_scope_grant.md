---
name: trust_scope_grant
tier: confirm
category: trust-scope
since: 0.1.0
stability: beta
---

# trust_scope_grant

Activate a proposed trust scope. CONFIRM-tier: opens an await_decision; on approve, flips the scope to active and emits trust_scope_granted.

## Tier behaviour

CONFIRM — opens an `await_decision` first. Only proceeds on approve. On reject/timeout, returns `{ ok: false, reason: ... }` and emits no success event. Trust scopes may grant blanket pre-approval for matching invocations (see [`docs/tool-cards/trust_scope_grant.md`](./trust_scope_grant.md)).

## Input schema

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    },
    "granted_by": {
      "type": "string",
      "default": "cowork-user-relayed"
    },
    "timeout_sec": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1800
    },
    "source_agent": {
      "type": "string",
      "default": "co"
    }
  },
  "required": [
    "id"
  ],
  "additionalProperties": false
}
```

## Output schema

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean",
          "const": true
        },
        "correlation_id": {
          "type": "string"
        },
        "scope": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "title": {
              "type": "string"
            },
            "description": {
              "type": "string"
            },
            "status": {
              "type": "string",
              "enum": [
                "proposed",
                "active",
                "expired",
                "revoked",
                "completed"
              ]
            },
            "allowed_actions": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "tool": {
                    "type": "string",
                    "minLength": 1
                  },
                  "param_constraints": {
                    "type": "object",
                    "additionalProperties": {}
                  },
                  "reason": {
                    "type": "string"
                  }
                },
                "required": [
                  "tool"
                ],
                "additionalProperties": false
              }
            },
            "forbidden_actions": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "tool": {
                    "type": "string",
                    "minLength": 1
                  },
                  "param_constraints": {
                    "type": "object",
                    "additionalProperties": {}
                  },
                  "reason": {
                    "type": "string"
                  }
                },
                "required": [
                  "tool"
                ],
                "additionalProperties": false
              }
            },
            "reporting": {
              "type": "object",
              "properties": {
                "cadence": {
                  "type": "string",
                  "enum": [
                    "every-action",
                    "every-5-actions",
                    "every-15-min",
                    "on-completion-only"
                  ]
                },
                "channels": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "enum": [
                      "chat",
                      "event-log",
                      "dashboard",
                      "slack",
                      "email"
                    ]
                  },
                  "minItems": 1
                }
              },
              "required": [
                "cadence",
                "channels"
              ],
              "additionalProperties": false
            },
            "proposed_at": {
              "type": "string"
            },
            "expires_at": {
              "type": "string"
            },
            "expires_after_actions": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "actions_executed": {
              "type": "integer",
              "minimum": 0
            },
            "granted_at": {
              "type": "string"
            },
            "granted_by": {
              "type": "string"
            },
            "spec_url": {
              "type": "string"
            }
          },
          "required": [
            "id",
            "title",
            "description",
            "status",
            "allowed_actions",
            "reporting",
            "proposed_at",
            "expires_at",
            "actions_executed"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "ok",
        "correlation_id",
        "scope"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean",
          "const": false
        },
        "reason": {
          "type": "string"
        },
        "correlation_id": {
          "type": "string"
        }
      },
      "required": [
        "ok",
        "reason"
      ],
      "additionalProperties": false
    }
  ]
}
```

## Side effects

- opens an await_decision (CONFIRM gate)
- on approve: flips scope status `proposed → active`, emits `trust_scope_granted`


## Error modes

- unknown scope id → isError
- scope not in `proposed` state → isError
- rejected_by_user

## See also

- `trust_scope_propose`
- `trust_scope_extend`
- `trust_scope_revoke`

---

_This file is generated by `scripts/generate-tool-catalogue.ts`. Edit `src/tools/catalogue-data.ts` and re-run `npm run docs:tools`._
