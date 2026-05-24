// Bombardment Phase 3d — minimal HTTP probe helper.
//
// Tiny GET wrapper with a bounded timeout, used by every federation
// oracle. Kept module-local on purpose — we don't want the oracles
// pulling in axios / undici / etc. just to read a couple of JSON
// endpoints.

import { request as httpRequest } from 'node:http';

export async function getJson(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        }
        try {
          resolve({ status: res.statusCode, body: JSON.parse(text) });
        } catch (err) {
          reject(new Error(`response from ${url} not JSON: ${err.message}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms on ${url}`));
    });
    req.end();
  });
}
