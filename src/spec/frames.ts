// refilm — derive spec rows when all we have is pixels.
//
// A video or gif has no DOM, so the honest output is coarse: where the picture changes and
// when. We measure that, label the regions spatially, and say plainly that the element
// identity, the CSS property, the direction and the travel distance are not measurable.
// A frames-only spec is a starting point, never a finished contract.

import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { familyOf } from "./easing.js";
import { roundTo, type RawRow } from "./row.js";

export interface FramesDerivation {
  rows: RawRow[];
  notes: string[];
  facts: Record<string, string | number>;
  activity: number[];
  fps: number;
}

export interface FrameGrid {
  cols: number;
  rows: number;
  /** Per block, the activity per frame (fraction of pixels changed since the previous frame). */
  blocks: Array<{ row: number; col: number; x: number; y: number; w: number; h: number; activity: number[] }>;
  width: number;
  height: number;
}

function readPng(path: string): PNG {
  return PNG.sync.read(readFileSync(path));
}

const DIFF_TOLERANCE = 12;

/** Fraction of pixels that differ by more than `DIFF_TOLERANCE` in any channel. */
function diffFraction(a: PNG, b: PNG, box?: { x: number; y: number; w: number; h: number }): number {
  const x0 = box ? Math.max(0, box.x) : 0;
  const y0 = box ? Math.max(0, box.y) : 0;
  const x1 = box ? Math.min(a.width, box.x + box.w) : a.width;
  const y1 = box ? Math.min(a.height, box.y + box.h) : a.height;
  let changed = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4;
      total++;
      if (
        Math.abs(a.data[i] - b.data[i]) > DIFF_TOLERANCE ||
        Math.abs(a.data[i + 1] - b.data[i + 1]) > DIFF_TOLERANCE ||
        Math.abs(a.data[i + 2] - b.data[i + 2]) > DIFF_TOLERANCE
      ) {
        changed++;
      }
    }
  }
  return total ? changed / total : 0;
}

/**
 * Activity of a frame sequence: per frame, how much changed since the previous one, overall
 * and per block of a grid. Blocks are how a pixel-only spec finds two things moving apart.
 */
export function frameGrid(frames: string[], cols = 4, rows = 3): FrameGrid {
  const first = readPng(frames[0]);
  const width = first.width;
  const height = first.height;
  const blockW = Math.max(1, Math.floor(width / cols));
  const blockH = Math.max(1, Math.floor(height / rows));
  const blocks = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      blocks.push({
        row: r,
        col: c,
        x: c * blockW,
        y: r * blockH,
        w: c === cols - 1 ? width - c * blockW : blockW,
        h: r === rows - 1 ? height - r * blockH : blockH,
        activity: [] as number[],
      });
    }
  }
  let prev = first;
  for (let i = 0; i < frames.length; i++) {
    const img = i === 0 ? first : readPng(frames[i]);
    for (const b of blocks) {
      b.activity.push(i === 0 ? 0 : diffFraction(prev, img, b));
    }
    prev = img;
  }
  return { cols, rows, blocks, width, height };
}

interface MotionSegment {
  first: number;
  last: number;
  peak: number;
  total: number;
}

function segments(activity: number[], threshold: number): MotionSegment[] {
  const out: MotionSegment[] = [];
  let cur: MotionSegment | null = null;
  for (let i = 0; i < activity.length; i++) {
    const v = activity[i];
    if (v > threshold) {
      if (!cur) cur = { first: i, last: i, peak: i, total: 0 };
      cur.last = i;
      if (v > activity[cur.peak]) cur.peak = i;
      cur.total += v;
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Where the easing shape sits: front-loaded change means ease-out, back-loaded means ease-in. */
function activityShapeFamily(activity: number[], seg: MotionSegment): { family: string; front: number; back: number } {
  const values = activity.slice(seg.first, seg.last + 1);
  const total = values.reduce((s, v) => s + v, 0);
  if (!total) return { family: "unknown", front: 0, back: 0 };
  const half = Math.ceil(values.length / 2);
  const front = values.slice(0, half).reduce((s, v) => s + v, 0) / total;
  const back = 1 - front;
  let family: string;
  if (Math.abs(front - back) < 0.12) family = "linear";
  else if (front > back) family = "ease-out";
  else family = "ease-in";
  return { family, front, back };
}

export interface FramesOptions {
  fps: number;
  triggerFrame?: number;
  preRollMs?: number;
}

export function deriveFromFrames(frames: string[], opts: FramesOptions): FramesDerivation {
  const rows: RawRow[] = [];
  const notes: string[] = [];
  const facts: Record<string, string | number> = {};
  const fps = opts.fps > 0 ? opts.fps : 25;
  const triggerFrame = opts.triggerFrame ?? 0;
  const preRollMs = opts.preRollMs ?? 0;
  const timeOf = (frame: number) => roundTo((frame / fps) * 1000 - preRollMs, 1);

  if (frames.length < 3) {
    notes.push(`only ${frames.length} frame(s): motion needs at least 3 to have a start, a middle and an end`);
    return { rows, notes, facts, activity: [], fps };
  }

  const grid = frameGrid(frames);
  facts["frames.count"] = frames.length;
  facts["frames.size"] = `${grid.width}x${grid.height}`;
  facts["frames.fps"] = fps;
  if (triggerFrame) facts["frames.triggerFrame"] = triggerFrame;

  // ---- global motion window
  const globalActivity = grid.blocks.reduce<number[]>((acc, b) => {
    b.activity.forEach((v, i) => {
      acc[i] = Math.max(acc[i] ?? 0, v);
    });
    return acc;
  }, []);
  const peakActivity = Math.max(...globalActivity, 0);
  if (peakActivity <= 0) {
    notes.push("no frame differs from the one before it: the reference does not move inside this recording");
    return { rows, notes, facts, activity: globalActivity, fps };
  }
  const threshold = Math.max(0.0005, peakActivity * 0.02);
  const globalSegments = segments(globalActivity, threshold);
  if (globalSegments.length) {
    const g = globalSegments[0];
    facts["frames.motionWindowMs"] = `${timeOf(g.first)} → ${timeOf(g.last)}`;
    facts["frames.motionMs"] = roundTo(((g.last - g.first + 1) / fps) * 1000, 1);
    if (globalSegments.length > 1) {
      notes.push(
        `${globalSegments.length} separate bursts of change (${globalSegments.map((s) => `${timeOf(s.first)}ms`).join(", ")}): the reference has more than one motion event, so a single tween does not describe it`,
      );
    }
  }

  // ---- per-block rows: a block that changes on its own schedule is a separate element
  const activeBlocks = grid.blocks.filter((b) => Math.max(...b.activity, 0) > threshold);
  const blockRows: Array<{ block: (typeof activeBlocks)[number]; seg: MotionSegment; startMs: number }> = [];
  for (const block of activeBlocks) {
    const segs = segments(block.activity, threshold);
    if (!segs.length) continue;
    const seg = segs.reduce((a, b) => (b.total > a.total ? b : a));
    blockRows.push({ block, seg, startMs: timeOf(seg.first) });
  }
  blockRows.sort((a, b) => a.startMs - b.startMs || a.block.row - b.block.row || a.block.col - b.block.col);

  for (const { block, seg, startMs } of blockRows) {
    const shape = activityShapeFamily(block.activity, seg);
    const durationMs = roundTo(((seg.last - seg.first + 1) / fps) * 1000, 1);
    rows.push({
      element: `region[r${block.row}c${block.col}]`,
      property: "visual-change",
      from: "rest",
      to: "moving",
      startMs,
      durationMs,
      easing: null,
      easingFamily: familyOf(shape.family) === "unknown" ? "unknown" : (familyOf(shape.family) as RawRow["easingFamily"]),
      overshoot: null,
      source: "frames",
      confidence: "low",
      group: "frames",
      index: block.row * grid.cols + block.col,
      note: `change is ${(shape.front * 100).toFixed(0)}% in the first half of the window — shape only, not a fitted curve`,
    });
  }

  // ---- stagger between the regions, when they start apart
  if (blockRows.length > 1) {
    const gaps: number[] = [];
    for (let i = 1; i < blockRows.length; i++) gaps.push(roundTo(blockRows[i].startMs - blockRows[i - 1].startMs, 1));
    const positive = gaps.filter((g) => g > 0);
    if (positive.length === gaps.length) {
      const min = Math.min(...gaps);
      const max = Math.max(...gaps);
      facts["frames.staggerGapMs"] = min === max ? min : `${min}–${max}`;
      notes.push(
        `regions start ${gaps.map((g) => `${g}ms`).join(", ")} apart — a stagger in pixels, but which element owns which region is not knowable from frames alone`,
      );
    }
  }

  // ---- the honest part: what pixels cannot tell us
  notes.push("no DOM in a pixel-only capture: element identity, the CSS property, direction and travel distance must come from the user or from a re-capture");
  notes.push(`the grid is ${grid.cols}x${grid.rows} blocks of ${Math.floor(grid.width / grid.cols)}x${Math.floor(grid.height / grid.rows)} px — a region is a place on screen, not an element`);
  notes.push("a row built from frames has confidence low by definition; confirm it against a capture with inspect.json or track.json before building against it");

  return { rows, notes, facts, activity: globalActivity, fps };
}
