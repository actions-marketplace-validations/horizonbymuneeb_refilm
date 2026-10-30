// refilm — the in-page element tracker.
//
// Installed before any page script so motion that starts at navigation is caught. One sample per animation
// frame: the element's box, opacity and transform, plus the scroll position. This is the ground truth for
// "where was it at t", and it works whether the motion came from CSS, WAAPI or a render loop.
/** Built with the selector list baked in; evaluated as an init script. */
export function trackerScript(selectors) {
    const list = JSON.stringify(selectors);
    return `(() => {
  const selectors = ${list};
  const store = (window.__filmTrack = { samples: [], running: true });
  const round = (n) => Math.round(n * 100) / 100;
  const sample = () => {
    if (!store.running) return;
    const t = performance.now();
    const els = {};
    for (const selector of selectors) {
      let el = null;
      try { el = document.querySelector(selector); } catch (e) { el = null; }
      if (!el) { els[selector] = null; continue; }
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      els[selector] = {
        x: round(box.x),
        y: round(box.y),
        w: round(box.width),
        h: round(box.height),
        opacity: Math.round(parseFloat(style.opacity) * 1000) / 1000,
        transform: style.transform,
      };
    }
    store.samples.push({ t, scrollY: Math.round(window.scrollY * 100) / 100, els });
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
})();`;
}
/** Records which context each canvas got, so inspection never has to call getContext itself. */
export const CONTEXT_PROBE = `(() => {
  for (const C of [self.HTMLCanvasElement, self.OffscreenCanvas]) {
    if (!C) continue;
    const original = C.prototype.getContext;
    C.prototype.getContext = function getContext(type) {
      const ctx = original.apply(this, arguments);
      if (ctx && !this.__filmCtx) { try { this.__filmCtx = String(type); } catch (e) {} }
      return ctx;
    };
  }
})();`;
/**
 * Keeps a canvas' drawing buffer readable.
 *
 * A WebGL context created with preserveDrawingBuffer:false is cleared once the compositor has taken the
 * frame, so a screenshot can land after the clear and record a blank or half-drawn canvas. That is invisible
 * to a human but it makes a virtual-clock capture of a GPU page nondeterministic, one frame at a time. Forcing
 * the attribute on changes nothing about what the page draws, only whether the result is still there to read.
 */
export const DRAWING_BUFFER_PATCH = `(() => {
  const patch = (proto) => {
    if (!proto) return;
    const original = proto.getContext;
    proto.getContext = function getContext(type) {
      const args = Array.prototype.slice.call(arguments);
      if (args.length > 1 && args[1] && typeof args[1] === "object" && !args[1].preserveDrawingBuffer) {
        args[1] = Object.assign({}, args[1], { preserveDrawingBuffer: true });
      } else if (args.length <= 1) {
        args[1] = { preserveDrawingBuffer: true };
      }
      return original.apply(this, args);
    };
  };
  patch(self.HTMLCanvasElement && HTMLCanvasElement.prototype);
  patch(self.OffscreenCanvas && OffscreenCanvas.prototype);
})();`;
