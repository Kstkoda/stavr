---
name: trust_scope_propose
tier: auto
category: trust-scope
since: 0.1.0
stability: beta
---

# trust_scope_propose

Propose a trust scope (auto-tier). Logs trust_scope_proposed; does NOT activate. Use trust_scope_grant to activate.

## Tier behaviour

AUTO — runs without confirmation. Read-only or has built-in escape hatches; the caller is responsible for using it intentionally.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "minLength": 1
    },
    "description": {
      "type": "string",
      "minLength": 1
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
      },
      "minItems": 1
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
    "expires_at": {
      "type": "string",
      "format": "date-time"
    },
    "expires_after_actions": {
      "type": "integer",
      "exclusiveMinimum": 0
    },
    "spec_url": {
      "type": "string"
    },
    "source_agent": {
      "type": "string",
      "default": "co"
    }
  },
  "required": [
    "title",
    "description",
    "allowed_actions"
  ],
  "additionalProperties": false
}
```

## Output schema

```json
{
  "type": "object",
  "properties": {
    "scope_id": {
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
    "scope_id",
    "scope"
  ],
  "additionalProperties": false
}
```

## Side effects

- creates a proposed trust scope row
- emits `trust_scope_proposed`


## Example

```json
{
  "args": {
    "title": "Auto-merge dependabot PRs",
    "description": "Allow merging dependabot PRs without confirmation",
    "allowed_actions": [
      {
        "tool": "github_merge_pr",
        "param_constraints": {
          "repo": "Kstkoda/stavr"
        }
      }
    ],
    "expires_after_actions": 10
  },
  "result": {
    "scope_id": "ts_...",
    "scope": {}
  }
}
```

## Error modes

- none — proposal is unconditionally accepted; activation is gated separately

## See also

- `trust_scope_grant`
- `trust_scope_status`

---

_This file is generated by `scripts/generate-tool-catalogue.ts`. Edit `src/tools/catalogue-data.ts` and re-run `npm run docs:tools`._
