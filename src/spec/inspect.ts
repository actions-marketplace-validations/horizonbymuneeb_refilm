// refilm — read a capture's inspect.json and turn declared CSS/WAAPI timing into spec rows.
//
// This is the highest-confidence source: the page told us the delay, the duration and the
// per-keyframe easing, so nothing here is inferred. Anything the declaration cannot answer
// (which sibling an animation belongs to, an infinite repeat, a keyframe rule with no
// animation attached) is reported as a note instead of a number.

import type { EasingFamily, SpecRow } from "../types.js";
import { classifyCurve, curveOf, familyOf, matrixParts } from "./fit-curve.js";
import { RawRow } from "./row.js";

export interface InspectTiming {
  delay?: number | string;
  duration?: number | string;
  easing?: string;
  iterations?: number;
  direction?: string;
  fill?: string;
  endDelay?: number;
}

export interface InspectKeyframe {
  offset?: number | string | null;
  easing?: string;
  [prop: string]: unknown;
}

export interface InspectAnimation {
  kind?: string;
  name?: string;
  target?: string;
  targetPath?: string | null;
  timing?: InspectTiming | null;
  keyframes?: InspectKeyframe[];
  playState?: string;
  currentTime?: number | null;
  timeline?: string;
  pseudoElement?: string | null;
}

export interface InspectNode {
  el?: string;
  rect?: number[];
  text?: string;
  style?: Record<string, string>;
}

export interface InspectFile {
  url?: string;
  title?: string;
  viewport?: [number, number] | { width: number; height: number };
  scrollY?: number;
  devicePixelRatio?: number;
  libs?: string[];
  fonts?: Array<{ family?: string; weight?: string; style?: string; status?: string }>;
  canvases?: Array<{ el?: string; context?: string; size?: number[]; css?: number[] }>;
  target?: { selector?: string; found?: boolean; rect?: number[] } | null;
  animations?: InspectAnimation[];
  keyframes?: Array<{ name?: string; css?: string }>;
  nodes?: InspectNode[];
  transitions?: Array<{ el?: string; property?: string; duration?: string; easing?: string; delay?: string }>;
  unreadableSheets?: string[];
}

export interface InspectDerivation {
  rows: RawRow[];
  notes: string[];
  facts: Record<string, string | number>;
  /** animation names that were declared but never attached to a captured animation */
  orphanKeyframes: string[];
  animationCount: number;
}

const ms = (v: unknown, fallback: number): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.endsWith("ms")) return Number.parseFloat(s);
    if (s.endsWith("s")) return Number.parseFloat(s) * 1000;
    const n = Number.parseFloat(s);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
};

export function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "row";
}

/** "div.card" + index 1 -> "div.card[1]"; index undefined leaves the tag alone. */
export function elementLabel(tag: string, index?: number): string {
  return index === undefined ? tag : `${tag}[${index}]`;
}

const TRANSFORM_CHANNELS = ["translateX", "translateY", "scale", "rotate"] as const;

interface ChannelValue {
  from: number;
  to: number;
}

/** Splits a transform pair into the channels that actually change. */
export function transformChannels(from: string, to: string): Array<{ property: string; from: number; to: number }> {
  const a = matrixParts(from);
  const b = matrixParts(to);
  const out: Array<{ property: string; from: number; to: number }> = [];
  const push = (property: string, x: number, y: number) => {
    if (Math.abs(x - y) > 1e-6) out.push({ property, from: round(x), to: round(y) });
  };
  push("translateX", a.tx, b.tx);
  push("translateY", a.ty, b.ty);
  // a uniform scale is one row; a stretched one is two, so the numbers stay meaningful
  if (Math.abs(a.sx - b.sx) > 1e-6 && Math.abs(a.sy - b.sy) > 1e-6 && Math.abs(a.sx - a.sy) < 1e-6 && Math.abs(b.sx - b.sy) < 1e-6) {
    out.push({ property: "scale", from: round(a.sx), to: round(b.sx) });
  } else {
    push("scaleX", a.sx, b.sx);
    push("scaleY", a.sy, b.sy);
  }
  push("rotate", a.rotate, b.rotate);
  return out;
}

function round(n: number, digits = 4): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

/** CSS property value -> comparable primitive (number when it is a plain number with a unit we know). */
function scalarValue(prop: string, value: unknown): number | string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (prop === "opacity" || prop === "scale" || prop === "zoom") {
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? round(n) : s;
  }
  const m = /^(-?[\d.]+)(px|deg|rad|%)?$/.exec(s);
  if (m) {
    let n = Number.parseFloat(m[1]);
    if (m[2] === "rad") n = round((n * 180) / Math.PI);
    return round(n);
  }
  return s;
}

/** Effective easing of a segment: the keyframe's own easing wins over the animation's. */
function segmentEasing(kf: InspectKeyframe | undefined, animation: InspectAnimation): string | null {
  const fromKf = kf?.easing;
  if (typeof fromKf === "string" && fromKf && fromKf !== "linear") return fromKf;
  const t = animation.timing?.easing;
  if (typeof t === "string" && t) return t;
  return typeof fromKf === "string" && fromKf ? fromKf : null;
}

function easingFamilyOf(easing: string | null): EasingFamily {
  const family = familyOf(easing);
  if (family !== "unknown") return family;
  const fn = curveOf(easing);
  return fn ? classifyCurve(fn) : "unknown";
}

interface AnimGroup {
  key: string;
  items: Array<{ anim: InspectAnimation; index: number }>;
}

/**
 * Animations that target the same tag and share a name are siblings of one effect. Their
 * order is taken from the declared delay: the first sibling starts first. When a capture
 * tracks the elements themselves, the caller can check this against real geometry.
 */
function groupAnimations(animations: InspectAnimation[], nodeCounts: Map<string, number>): AnimGroup[] {
  const byKey = new Map<string, InspectAnimation[]>();
  for (const anim of animations) {
    const target = anim.target ?? "(unknown)";
    const name = anim.name ?? "";
    const duration = ms(anim.timing?.duration, 0);
    const key = `${target}|${name}|${Math.round(duration)}`;
    const list = byKey.get(key) ?? [];
    list.push(anim);
    byKey.set(key, list);
  }
  const groups: AnimGroup[] = [];
  for (const [key, list] of byKey) {
    const ordered = [...list].sort((a, b) => ms(a.timing?.delay, 0) - ms(b.timing?.delay, 0));
    const tag = ordered[0]?.target ?? "(unknown)";
    const declared = nodeCounts.get(tag) ?? 0;
    const useIndex = ordered.length > 1 && declared !== 1;
    groups.push({
      key,
      items: ordered.map((anim, i) => ({ anim, index: useIndex ? i : 0 })),
    });
  }
  return groups;
}

export function deriveFromInspect(inspect: InspectFile, opts: { fps: number } = { fps: 25 }): InspectDerivation {
  const rows: RawRow[] = [];
  const notes: string[] = [];
  const facts: Record<string, string | number> = {};
  const animations = Array.isArray(inspect.animations) ? inspect.animations : [];
  const nodes = Array.isArray(inspect.nodes) ? inspect.nodes : [];

  const nodeCounts = new Map<string, number>();
  for (const n of nodes) {
    if (!n.el) continue;
    nodeCounts.set(n.el, (nodeCounts.get(n.el) ?? 0) + 1);
  }

  if (inspect.url) facts["target.url"] = inspect.url;
  if (inspect.title) facts["target.title"] = inspect.title;
  if (inspect.target?.selector) facts["target.selector"] = inspect.target.selector;
  if (inspect.libs?.length) facts["target.libs"] = inspect.libs.join(", ");
  if (Array.isArray(inspect.canvases) && inspect.canvases.length) {
    facts["target.canvases"] = inspect.canvases.length;
    const contexts = [...new Set(inspect.canvases.map((c) => c.context).filter(Boolean))];
    if (contexts.length) facts["target.canvasContexts"] = contexts.join(", ");
  }
  const fontFamilies = [...new Set((inspect.fonts ?? []).map((f) => f.family).filter(Boolean))] as string[];
  facts["fonts.families"] = fontFamilies.length ? fontFamilies.join(", ") : "(none recorded)";
  facts["fonts.count"] = (inspect.fonts ?? []).length;
  facts["nodes.count"] = nodes.length;
  facts["keyframeRules.count"] = (inspect.keyframes ?? []).length;
  facts["animations.count"] = animations.length;
  facts["devicePixelRatio"] = inspect.devicePixelRatio ?? 1;

  // Style facts for the elements that animate: these are what a clone must reproduce even at
  // motion fidelity, because a wrong radius or colour changes the diff at rest.
  const animatedTags = [...new Set(animations.map((a) => a.target).filter(Boolean) as string[])];
  const STYLE_KEYS = [
    "background-color",
    "color",
    "border-radius",
    "font-family",
    "font-size",
    "font-weight",
    "display",
    "gap",
    "box-shadow",
    "overflow",
    "transform-origin",
    "will-change",
    "animation",
  ];
  for (const tag of animatedTags) {
    const node = nodes.find((n) => n.el === tag);
    if (!node?.style) continue;
    for (const key of STYLE_KEYS) {
      const value = node.style[key];
      if (value === undefined || value === "" || value === "none" || value === "normal") continue;
      facts[`style.${tag}.${key}`] = value;
    }
  }

  const groups = groupAnimations(animations, nodeCounts);
  const usedAnimations = new Set<InspectAnimation>();

  for (const group of groups) {
    const { items } = group;
    const baseTag = items[0]?.anim.target ?? "(unknown)";
    const declaredSiblings = nodeCounts.get(baseTag) ?? 0;
    if (items.length > 1 && declaredSiblings > 0 && items.length !== declaredSiblings) {
      notes.push(
        `${baseTag}: ${items.length} declared animations but ${declaredSiblings} elements with that tag — index order comes from the declared delays`,
      );
    }
    if (items.length > 1 && declaredSiblings === 0) {
      notes.push(`${baseTag}: sibling order taken from the declared delays; no node geometry in inspect.json to confirm it`);
    }

    for (const { anim, index } of items) {
      usedAnimations.add(anim);
      const timing = anim.timing ?? {};
      const delay = ms(timing.delay, 0);
      const duration = ms(timing.duration, 0);
      const iterations = Number.isFinite(Number(timing.iterations)) ? Number(timing.iterations) : 1;
      const direction = (timing.direction ?? "normal").toString();
      const fill = (timing.fill ?? "none").toString();
      const element = elementLabel(baseTag, items.length > 1 ? index : undefined);
      const kfs = (anim.keyframes ?? []).filter((k) => k && typeof k === "object");

      if (!kfs.length) {
        notes.push(`${element} (${anim.name ?? anim.kind ?? "animation"}): declared with no keyframes — timing only, properties unknown`);
        continue;
      }
      if (anim.pseudoElement) {
        notes.push(`${element}: animation targets pseudo-element ${anim.pseudoElement}; it cannot be tracked and must be recreated as a real element`);
      }
      if (!Number.isFinite(iterations) || iterations !== 1) {
        notes.push(
          `${element} (${anim.name ?? "animation"}): repeats ${iterations === Infinity ? "forever" : `${iterations}×`} (${direction}) — one cycle is ${Math.round(duration)} ms; a loop is not a one-shot tween`,
        );
      }
      if (direction !== "normal" && direction !== "forwards") {
        notes.push(`${element}: direction "${direction}" — the visible start and end differ from the declared from/to`);
      }
      if (fill === "none" || fill === "backwards" || fill === "both") {
        notes.push(`${element}: fill-mode "${fill}" — the resting state after the animation is not the declared end value`);
      }

      // Segment the keyframes: two keyframes are one tween, more are several in sequence.
      const offsets = kfs.map((k, i) => {
        const raw = k.offset;
        if (typeof raw === "number" && Number.isFinite(raw)) return raw;
        if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
        return kfs.length === 1 ? 0 : i / (kfs.length - 1);
      });
      const segCount = Math.max(1, kfs.length - 1);
      if (kfs.length > 2) {
        notes.push(`${element} (${anim.name ?? "animation"}): ${kfs.length} keyframes — emitted one row per segment`);
      }

      for (let seg = 0; seg < segCount; seg++) {
        const a = kfs[seg];
        const b = kfs[Math.min(seg + 1, kfs.length - 1)];
        const segStart = delay + (duration * (offsets[seg] ?? 0));
        const segDuration = duration * Math.max(0, (offsets[Math.min(seg + 1, offsets.length - 1)] ?? 1) - (offsets[seg] ?? 0));
        const easing = segmentEasing(a, anim);
        const family = easingFamilyOf(easing);
        const props = new Set<string>();
        for (const k of [a, b]) {
          for (const key of Object.keys(k)) {
            if (["offset", "easing", "composite", "computedOffset"].includes(key)) continue;
            props.add(key);
          }
        }

        for (const prop of props) {
          const fromRaw = a[prop];
          const toRaw = b[prop];
          if (prop === "transform") {
            if (typeof fromRaw !== "string" || typeof toRaw !== "string") {
              notes.push(`${element}: transform keyframes are not strings (${String(fromRaw)} → ${String(toRaw)}) — cannot read the channels`);
              continue;
            }
            const channels = transformChannels(fromRaw, toRaw);
            if (!channels.length) {
              notes.push(`${element}: transform declared but no channel changes (${fromRaw} → ${toRaw})`);
              continue;
            }
            for (const ch of channels) {
              rows.push({
                element,
                property: ch.property,
                from: ch.from,
                to: ch.to,
                startMs: round(segStart, 2),
                durationMs: round(segDuration, 2),
                easing,
                easingFamily: family,
                overshoot: family === "spring" ? null : 0,
                source: "declared",
                confidence: iterations === 1 && direction === "normal" ? "high" : "medium",
                group: `${baseTag}|${ch.property}`,
                index: items.length > 1 ? index : undefined,
                note: family === "unknown" ? `easing "${easing ?? "(none)"}" could not be classified` : undefined,
              });
            }
            continue;
          }
          const from = scalarValue(prop, fromRaw);
          const to = scalarValue(prop, toRaw);
          if (from === null || to === null) {
            notes.push(`${element}.${prop}: keyframe value missing (${String(fromRaw)} → ${String(toRaw)})`);
            continue;
          }
          if (from === to) continue;
          rows.push({
            element,
            property: prop,
            from,
            to,
            startMs: round(segStart, 2),
            durationMs: round(segDuration, 2),
            easing,
            easingFamily: family,
            overshoot: family === "spring" ? null : 0,
            source: "declared",
            confidence: iterations === 1 && direction === "normal" ? "high" : "medium",
            group: `${baseTag}|${prop}`,
            index: items.length > 1 ? index : undefined,
            note: family === "unknown" ? `easing "${easing ?? "(none)"}" could not be classified` : undefined,
          });
        }
      }
    }
  }

  // Declared keyframe rules with no animation attached: real motion we know exists but cannot time.
  const animationNames = new Set(animations.map((a) => a.name).filter(Boolean) as string[]);
  const orphans: string[] = [];
  for (const rule of inspect.keyframes ?? []) {
    if (!rule?.name || animationNames.has(rule.name)) continue;
    orphans.push(rule.name);
  }
  if (orphans.length) {
    notes.push(
      `keyframe rule(s) ${orphans.map((n) => `"${n}"`).join(", ")} declared but no captured animation uses them — either outside the inspected subtree or triggered by an interaction that was not recorded`,
    );
  }

  const transitions = inspect.transitions ?? [];
  if (transitions.length && !animations.length) {
    notes.push(
      `${transitions.length} CSS transition(s) declared, none captured: transitions need an interaction trigger, so their timing was not observed`,
    );
  }
  if (!animations.length) {
    notes.push("inspect.json lists no animations: this capture has no declared motion to copy");
  }

  return { rows, notes, facts, orphanKeyframes: orphans, animationCount: animations.length };
}

/** Counts how many captured animations each element label covers, for the spec summary. */
export function animatedElementCount(rows: RawRow[]): number {
  return new Set(rows.map((r) => r.element)).size;
}

export type { ChannelValue, TRANSFORM_CHANNELS };
