// refilm — the intermediate row every evidence source produces, before spec assembly.
//
// Keeping this separate from `SpecRow` means a source never has to invent a stagger, an id or
// a confidence it cannot justify: those are decided once, in `derive.ts`, from the evidence.

import type { EasingFamily, SpecRow } from "../types.js";

export interface RawRow {
  element: string;
  property: string;
  from: number | string;
  to: number | string;
  startMs: number | null;
  durationMs: number | null;
  easing: string | null;
  easingFamily: EasingFamily;
  overshoot: number | null;
  source: SpecRow["source"];
  confidence: SpecRow["confidence"];
  /** Rows sharing a group are siblings of one effect: the stagger is measured inside it. */
  group: string;
  /** Position of this element among its siblings, when the evidence gives an order. */
  index?: number;
  /** Measured gap to the previous sibling, filled in during assembly (never by a source). */
  staggerMs?: number | null;
  /** Why this row is weaker than its source normally allows. */
  note?: string;
}

/** A measured property series for one element, ready to fit. */
export interface ElementSeries {
  element: string;
  property: string;
  series: Array<[number, number]>;
}

export const roundTo = (n: number, digits = 2): number => {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
};
