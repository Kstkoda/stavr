/**
 * Topology adapter — computes node layout from the daemon's worker /
 * brick / BOM state. Pure functions; no DOM.
 *
 * Layout invariants (project_cowire_dashboard_modes.md):
 *  - Steward in the centre as a red node.
 *  - Bricks above the bus (external) — purple / blue / orange / yellow
 *    by kind.
 *  - Workers below the bus (internal) — green / amber / red / grey by
 *    status.
 *  - No connecting lines between nodes. Presence == registration.
 */
import type { WorkerRecord, WorkerStatusT } from '../../persistence.js';
import type { BrickKind } from '../components/brick.js';

export type TopologyBrickKind = 'ai-external' | 'ai-internal' | 'mcp' | 'connector-above' | 'connector-below';

export interface InstalledBrickLite {
  id: string;
  kind: string;
  display_name: string;
  enabled: boolean;
}

export interface TopologyNode {
  id: string;
  brickKind: BrickKind;
  displayName: string;
  position: 'above' | 'below';
  status?: 'idle' | 'running' | 'error' | 'disabled';
  /** Origin coordinate of the brick's top-left in SVG units. */
  x: number;
  y: number;
  /** Layer label used for the inspector. */
  layer: 'brick' | 'worker' | 'steward';
  raw?: unknown;
}

export interface LayoutInput {
  workers: WorkerRecord[];
  bricks: InstalledBrickLite[];
  width?: number;
  /** Bus row y-coordinate; nodes are placed above and below this line. */
  busY?: number;
  brickWidth?: number;
  brickHeight?: number;
  /** Horizontal gap between bricks. */
  gap?: number;
}

const DEFAULT_WIDTH = 900;
const DEFAULT_BUS_Y = 250;
const DEFAULT_BRICK_W = 110;
const DEFAULT_BRICK_H = 60;
const DEFAULT_GAP = 14;

function mapBrickKind(kind: string): BrickKind {
  const k = kind.toLowerCase();
  if (k.includes('ai') && k.includes('ext')) return 'ai-external';
  if (k.includes('ai') && k.includes('int')) return 'ai-internal';
  if (k.includes('llm')) return 'ai-external';
  if (k === 'mcp' || k.includes('mcp')) return 'mcp';
  if (k.includes('webhook') || k.includes('http')) return 'connector-above';
  if (k.includes('local') || k.includes('fs') || k.includes('disk')) return 'connector-below';
  return 'connector-above';
}

function mapWorkerStatus(s: WorkerStatusT): 'idle' | 'running' | 'error' | 'disabled' {
  switch (s) {
    case 'idle':       return 'idle';
    case 'starting':
    case 'running':    return 'running';
    case 'crashed':    return 'error';
    case 'terminated': return 'disabled';
  }
}

/**
 * Lay out bricks above the bus and workers below. Each row centres its
 * contents and wraps when it overflows the canvas width.
 */
export function computeTopology(input: LayoutInput): { nodes: TopologyNode[]; steward: { x: number; y: number; r: number }; width: number; height: number } {
  const width = input.width ?? DEFAULT_WIDTH;
  const busY = input.busY ?? DEFAULT_BUS_Y;
  const bw = input.brickWidth ?? DEFAULT_BRICK_W;
  const bh = input.brickHeight ?? DEFAULT_BRICK_H;
  const gap = input.gap ?? DEFAULT_GAP;

  const perRow = Math.max(1, Math.floor((width - 40) / (bw + gap)));
  const rowH = bh + 24;

  function rowAt(yBase: number, items: Array<{ id: string; displayName: string; brickKind: BrickKind; status?: TopologyNode['status']; layer: TopologyNode['layer']; raw?: unknown }>, dir: 'above' | 'below'): TopologyNode[] {
    const out: TopologyNode[] = [];
    items.forEach((it, idx) => {
      const row = Math.floor(idx / perRow);
      const col = idx % perRow;
      const inRow = Math.min(items.length - row * perRow, perRow);
      const totalW = inRow * bw + (inRow - 1) * gap;
      const startX = (width - totalW) / 2;
      const x = startX + col * (bw + gap);
      const y = dir === 'above'
        ? yBase - (row + 1) * rowH
        : yBase + 14 + row * rowH;
      out.push({ ...it, x, y, position: dir });
    });
    return out;
  }

  const brickItems = input.bricks
    .filter((b) => b.enabled !== false)
    .map((b) => ({
      id: b.id,
      displayName: b.display_name,
      brickKind: mapBrickKind(b.kind),
      status: undefined as TopologyNode['status'],
      layer: 'brick' as const,
      raw: b,
    }));

  const workerItems = input.workers
    .filter((w) => w.status !== 'terminated' || timestampAfter(w.ended_at, Date.now() - 60_000))
    .map((w) => ({
      id: w.id,
      displayName: w.name || w.type,
      brickKind: pickWorkerBrickKind(w),
      status: mapWorkerStatus(w.status),
      layer: 'worker' as const,
      raw: w,
    }));

  const brickRow = rowAt(busY, brickItems, 'above');
  const workerRow = rowAt(busY, workerItems, 'below');

  const stewardX = width / 2;
  const stewardY = busY;
  const stewardR = 32;

  // Canvas height: top-most brick row through bottom-most worker row +
  // padding for the scrubber, plus an extra row for breathing room.
  const brickRowsCount = Math.max(1, Math.ceil(brickItems.length / perRow));
  const workerRowsCount = Math.max(1, Math.ceil(workerItems.length / perRow));
  const height = busY + 14 + workerRowsCount * rowH + 40 + (brickItems.length === 0 ? 0 : 0);
  void brickRowsCount;

  return {
    nodes: [...brickRow, ...workerRow],
    steward: { x: stewardX, y: stewardY, r: stewardR },
    width,
    height,
  };
}

function timestampAfter(iso: string | undefined, ts: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= ts;
}

function pickWorkerBrickKind(w: WorkerRecord): BrickKind {
  if (w.type === 'cc' || w.type === 'opus' || w.type === 'sonnet') return 'ai-external';
  if (w.type === 'haiku' || w.type === 'internal') return 'ai-internal';
  return 'connector-below';
}
