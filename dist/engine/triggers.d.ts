import type { Page } from "playwright";
import type { CaptureOptions } from "../types.js";
export interface Point {
    x: number;
    y: number;
}
export interface Action {
    /** Virtual milliseconds after the trigger. */
    at: number;
    run: () => Promise<unknown>;
}
/** Pointer position inside an element, as fractions of its box. */
export declare function pointAt(page: Page, selector: string, fx: number, fy: number): Promise<Point>;
/** The scroll position a scroll trigger should reach, in CSS px. */
export declare function scrollTarget(page: Page, opts: CaptureOptions): Promise<number>;
/** Builds the action list for a virtual-clock capture. `at` is relative to the trigger. */
export declare function planActions(page: Page, opts: CaptureOptions): Promise<Action[]>;
/** Runs the trigger on the wall clock; returns when it finished. */
export declare function runTrigger(page: Page, opts: CaptureOptions): Promise<void>;
/**
 * Settle time before the trigger. On the virtual clock this is virtual time, so a page that waits
 * 800 ms before starting its intro starts it on the same frame every capture.
 */
export declare function settle(page: Page, opts: CaptureOptions, ms: number): Promise<void>;
/** Everything that has to be in place before the trigger fires. */
export declare function prepare(page: Page, opts: CaptureOptions): Promise<void>;
