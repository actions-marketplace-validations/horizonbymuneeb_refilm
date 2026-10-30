// refilm — triggers: the input that starts the motion.
//
// Two paths, one meaning:
//   real clock    the trigger runs against the wall clock; the recording window starts at it.
//   virtual clock the trigger becomes a list of actions stamped with a virtual time, so a pointer glide or
//                 a stepped wheel lands on the same frame of the same capture every run.
//
// Every action is expressed as "do this at virtual millisecond N", which is also how the real path is
// written, so the two cannot drift apart.

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
export async function pointAt(page: Page, selector: string, fx: number, fy: number): Promise<Point> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`not visible: ${selector}`);
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

/** The scroll position a scroll trigger should reach, in CSS px. */
export async function scrollTarget(page: Page, opts: CaptureOptions): Promise<number> {
  if (opts.scrollTo !== undefined && /^\d+$/.test(opts.scrollTo)) return Number(opts.scrollTo);
  const selector = opts.scrollTo ?? opts.selector;
  if (!selector) throw new Error("a scroll trigger needs --scroll-to or --selector");
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error("not found: " + sel);
    return window.scrollY + el.getBoundingClientRect().top - innerHeight * 0.25;
  }, selector);
}

/** Fractions of --path-ms spent between two consecutive path points, one pointer step per virtual tick. */
function glideSteps(opts: CaptureOptions): number {
  const tick = 1000 / opts.rafHz;
  return Math.max(1, Math.round(opts.pathMs / tick));
}

async function pathPoints(page: Page, opts: CaptureOptions): Promise<Point[]> {
  const target = opts.target;
  if (!target) throw new Error(`--trigger ${opts.trigger} needs --target (or --selector)`);
  const points: Point[] = [];
  for (const p of opts.path) points.push(await pointAt(page, target, p.x, p.y));
  return points;
}

/** Builds the action list for a virtual-clock capture. `at` is relative to the trigger. */
export async function planActions(page: Page, opts: CaptureOptions): Promise<Action[]> {
  switch (opts.trigger) {
    case "load":
    case "none":
      return [];

    case "hover": {
      const point = await pointAt(page, opts.target!, opts.hoverAt.x, opts.hoverAt.y);
      return [{ at: 0, run: () => page.mouse.move(point.x, point.y) }];
    }

    case "leave":
      return [{ at: 0, run: () => page.mouse.move(opts.leaveTo!.x, opts.leaveTo!.y) }];

    case "click":
      return [
        {
          at: 0,
          run: () => page.click(opts.target!, { timeout: 10000, noWaitAfter: true }),
        },
      ];

    case "move":
    case "drag": {
      const points = await pathPoints(page, opts);
      const steps = glideSteps(opts);
      const actions: Action[] = [
        {
          at: 0,
          run: async () => {
            await page.mouse.move(points[0].x, points[0].y);
            if (opts.trigger === "drag") await page.mouse.down();
          },
        },
      ];
      for (let i = 1; i < points.length; i++) {
        for (let k = 1; k <= steps; k++) {
          const f = k / steps;
          const from = points[i - 1];
          const to = points[i];
          actions.push({
            at: (i - 1) * opts.pathMs + f * opts.pathMs,
            run: () => page.mouse.move(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f),
          });
        }
      }
      if (opts.trigger === "drag") {
        // released while still moving, so fling / inertia code sees a velocity
        actions.push({ at: actions[actions.length - 1].at, run: () => page.mouse.up() });
      }
      return actions;
    }

    case "scroll": {
      const from = await page.evaluate(() => window.scrollY);
      const delta = ((await scrollTarget(page, opts)) - from) / opts.scrollSteps;
      const actions: Action[] = [{ at: 0, run: () => page.mouse.move(opts.viewport.width / 2, opts.viewport.height / 2) }];
      for (let i = 0; i < opts.scrollSteps; i++) {
        actions.push({ at: (i * opts.scrollMs) / opts.scrollSteps, run: () => page.mouse.wheel(0, delta) });
      }
      return actions;
    }

    default:
      throw new Error(`unknown trigger ${opts.trigger}`);
  }
}

/** Runs the trigger on the wall clock; returns when it finished. */
export async function runTrigger(page: Page, opts: CaptureOptions): Promise<void> {
  const actions = await planActions(page, opts);
  if (!actions.length) return;
  if (opts.trigger === "scroll" || opts.trigger === "move" || opts.trigger === "drag") {
    // real path: replay the plan with real waits between the steps it asked for
    const start = Date.now();
    for (const action of actions) {
      const wait = action.at - (Date.now() - start);
      if (wait > 0) await page.waitForTimeout(wait);
      await action.run();
    }
    return;
  }
  for (const action of actions) await action.run();
}

/**
 * Settle time before the trigger. On the virtual clock this is virtual time, so a page that waits
 * 800 ms before starting its intro starts it on the same frame every capture.
 */
export async function settle(page: Page, opts: CaptureOptions, ms: number): Promise<void> {
  if (opts.clock !== "virtual") {
    if (ms > 0) await page.waitForTimeout(ms);
    return;
  }
  for (let left = ms; left > 0; left -= 100) {
    await page.evaluate((step) => (window as any).__filmClock.step(step), Math.min(100, left));
  }
}

/** Everything that has to be in place before the trigger fires. */
export async function prepare(page: Page, opts: CaptureOptions): Promise<void> {
  await settle(page, opts, opts.waitBefore);

  if (opts.preJs) {
    await page.evaluate(opts.preJs);
    await settle(page, opts, 50);
  }

  if (opts.selector && opts.trigger !== "scroll") {
    const found = await page.$(opts.selector);
    if (!found) throw new Error(`selector not found: ${opts.selector}`);
    await found.scrollIntoViewIfNeeded();
    await settle(page, opts, 300);
  } else if (opts.trigger === "scroll" && opts.selector) {
    // start just below the fold so the element enters the viewport during the scroll
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) window.scrollTo(0, Math.max(0, window.scrollY + el.getBoundingClientRect().top - innerHeight - 20));
    }, opts.selector);
    await settle(page, opts, 300);
  }

  if (opts.preHover) {
    const point = await pointAt(page, opts.preHover, opts.hoverAt.x, opts.hoverAt.y);
    await page.mouse.move(point.x, point.y);
    await settle(page, opts, opts.preHoverMs);
  }
}
