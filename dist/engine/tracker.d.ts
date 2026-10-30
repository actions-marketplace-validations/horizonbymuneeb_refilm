/** Built with the selector list baked in; evaluated as an init script. */
export declare function trackerScript(selectors: string[]): string;
/** Records which context each canvas got, so inspection never has to call getContext itself. */
export declare const CONTEXT_PROBE = "(() => {\n  for (const C of [self.HTMLCanvasElement, self.OffscreenCanvas]) {\n    if (!C) continue;\n    const original = C.prototype.getContext;\n    C.prototype.getContext = function getContext(type) {\n      const ctx = original.apply(this, arguments);\n      if (ctx && !this.__filmCtx) { try { this.__filmCtx = String(type); } catch (e) {} }\n      return ctx;\n    };\n  }\n})();";
