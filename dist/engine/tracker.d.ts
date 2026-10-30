/** Built with the selector list baked in; evaluated as an init script. */
export declare function trackerScript(selectors: string[]): string;
/** Records which context each canvas got, so inspection never has to call getContext itself. */
export declare const CONTEXT_PROBE = "(() => {\n  for (const C of [self.HTMLCanvasElement, self.OffscreenCanvas]) {\n    if (!C) continue;\n    const original = C.prototype.getContext;\n    C.prototype.getContext = function getContext(type) {\n      const ctx = original.apply(this, arguments);\n      if (ctx && !this.__filmCtx) { try { this.__filmCtx = String(type); } catch (e) {} }\n      return ctx;\n    };\n  }\n})();";
/**
 * Keeps a canvas' drawing buffer readable.
 *
 * A WebGL context created with preserveDrawingBuffer:false is cleared once the compositor has taken the
 * frame, so a screenshot can land after the clear and record a blank or half-drawn canvas. That is invisible
 * to a human but it makes a virtual-clock capture of a GPU page nondeterministic, one frame at a time. Forcing
 * the attribute on changes nothing about what the page draws, only whether the result is still there to read.
 */
export declare const DRAWING_BUFFER_PATCH = "(() => {\n  const patch = (proto) => {\n    if (!proto) return;\n    const original = proto.getContext;\n    proto.getContext = function getContext(type) {\n      const args = Array.prototype.slice.call(arguments);\n      if (args.length > 1 && args[1] && typeof args[1] === \"object\" && !args[1].preserveDrawingBuffer) {\n        args[1] = Object.assign({}, args[1], { preserveDrawingBuffer: true });\n      } else if (args.length <= 1) {\n        args[1] = { preserveDrawingBuffer: true };\n      }\n      return original.apply(this, args);\n    };\n  };\n  patch(self.HTMLCanvasElement && HTMLCanvasElement.prototype);\n  patch(self.OffscreenCanvas && OffscreenCanvas.prototype);\n})();";
