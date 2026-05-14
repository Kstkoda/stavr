// proposed/sample-brick-webhook/index.mjs
//
// Sample local brick for the v0.2 smoke test. Wraps the in-tree
// WebhookConnector so the installer has something concrete to load and the
// planner has a capability to discover.

import { makeWebhookConnector } from '../../dist/connectors/webhook.js';

export default function factory({ manifest }) {
  return makeWebhookConnector({
    id: manifest.id,
    displayName: manifest.display_name,
    config: {
      url: 'https://httpbin.org/post',
      method: 'POST',
    },
  });
}
