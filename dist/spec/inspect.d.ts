import type { RawRow } from "./row.js";
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
    viewport?: [number, number] | {
        width: number;
        height: number;
    };
    scrollY?: number;
    devicePixelRatio?: number;
    libs?: string[];
    fonts?: Array<{
        family?: string;
        weight?: string;
        style?: string;
        status?: string;
    }>;
    canvases?: Array<{
        el?: string;
        context?: string;
        size?: number[];
        css?: number[];
    }>;
    target?: {
        selector?: string;
        found?: boolean;
        rect?: number[];
    } | null;
    animations?: InspectAnimation[];
    keyframes?: Array<{
        name?: string;
        css?: string;
    }>;
    nodes?: InspectNode[];
    transitions?: Array<{
        el?: string;
        property?: string;
        duration?: string;
        easing?: string;
        delay?: string;
    }>;
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
export declare function slug(input: string): string;
/** "div.card" + index 1 -> "div.card[1]"; index undefined leaves the tag alone. */
export declare function elementLabel(tag: string, index?: number): string;
declare const TRANSFORM_CHANNELS: readonly ["translateX", "translateY", "scale", "rotate"];
interface ChannelValue {
    from: number;
    to: number;
}
/** Splits a transform pair into the channels that actually change. */
export declare function transformChannels(from: string, to: string): Array<{
    property: string;
    from: number;
    to: number;
}>;
export declare function deriveFromInspect(inspect: InspectFile, opts?: {
    fps: number;
}): InspectDerivation;
/** Counts how many captured animations each element label covers, for the spec summary. */
export declare function animatedElementCount(rows: RawRow[]): number;
export type { ChannelValue, TRANSFORM_CHANNELS };
