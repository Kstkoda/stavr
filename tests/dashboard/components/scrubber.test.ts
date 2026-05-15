import { describe, expect, it } from 'vitest';
import { renderScrubber } from '../../../src/dashboard/components/scrubber.js';

describe('scrubber component', () => {
  it('renders a range input with min=0 and value=max so it starts at live', () => {
    const html = renderScrubber({ steps: 50 });
    expect(html).toContain('type="range"');
    expect(html).toContain('min="0"');
    expect(html).toContain('max="50"');
    expect(html).toContain('value="50"');
    expect(html).toContain('aria-label="Time scrubber"');
  });

  it('clamps steps to at least 1', () => {
    expect(renderScrubber({ steps: 0 })).toContain('max="1"');
  });

  it('uses a custom id when supplied', () => {
    expect(renderScrubber({ id: 'topo-time' })).toContain('id="topo-time"');
  });
});
