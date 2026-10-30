// refilm — the in-page inspection dump.
//
// Runs after the motion, when getAnimations() has seen everything: declared CSS animations, WAAPI
// animations, transitions, the keyframe rules the page declares, computed styles of the nodes in the target
// subtree, loaded fonts, the libraries in play, the canvases and the target rect. This is the file an agent
// reads to know what it has to rebuild; it must describe the page, never guess.

/** Serialised as a function and evaluated in the page; keep it self-contained (no imports, no closures). */
export const INSPECT_SCRIPT = String.raw`(selector) => {
  const tagOf = (el) => {
    if (!el) return null;
    let s = (el.tagName || "?").toLowerCase();
    if (el.id) s += "#" + el.id;
    if (el.classList && el.classList.length) s += "." + [...el.classList].slice(0, 4).join(".");
    return s;
  };
  const probe = (fn) => { try { return !!fn(); } catch (e) { return false; } };
  const w = window;
  const root = selector ? document.querySelector(selector) : document.body;
  const libs = [];

  // ---- libraries: globals, devtools hooks, DOM markers and resource names
  if (probe(() => w.gsap)) libs.push("gsap" + (probe(() => w.ScrollTrigger) ? "+ScrollTrigger" : ""));
  if (probe(() => w.THREE || w.__THREE__)) libs.push("three");
  if (probe(() => w.PIXI || w.__PIXI_APP__ || w.__PIXI_RENDERER__ || w.__PIXI_APP_INIT__)) libs.push("pixi");
  if (probe(() => w.pc && w.pc.Application)) libs.push("playcanvas");
  if (probe(() => w.BABYLON)) libs.push("babylon");
  if (probe(() => w.ogl || w.createREGL)) libs.push("ogl");
  if (probe(() => w.lottie || w.bodymovin || document.querySelector("lottie-player,dotlottie-player,[data-lottie],.lottie"))) libs.push("lottie");
  if (probe(() => w.rive || document.querySelector("canvas[data-rive],.rive-canvas"))) libs.push("rive");
  if (probe(() => w.anime)) libs.push("anime");
  if (probe(() => w.Lenis || document.documentElement.classList.contains("lenis"))) libs.push("lenis");
  if (probe(() => w.VANTA)) libs.push("vanta");
  if (probe(() => w.UnicornStudio || document.querySelector("[data-us-project]"))) libs.push("unicorn-studio");
  if (probe(() => document.querySelector("spline-viewer") || [...document.scripts].some((s) => /splinetool|spline\.design/.test(s.src)))) libs.push("spline");
  if (probe(() => w.Webflow || document.querySelector("[data-wf-page]"))) libs.push("webflow");
  if (probe(() => document.querySelector("[data-framer-name],[data-framer-component-type]") || [...document.scripts].some((s) => /framer-motion|motion-dom/.test(s.src)))) libs.push("framer-motion");
  if (probe(() => w.__NEXT_DATA__ || document.getElementById("__next"))) libs.push("next");
  if (probe(() => w.__nuxt)) libs.push("nuxt");
  if (probe(() => document.querySelector("astro-island"))) libs.push("astro");
  if (probe(() => document.querySelector(".swiper,.splide,.slick-slider,.embla"))) libs.push("carousel");
  if (probe(() => [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.cssText.includes("animation-timeline") || r.cssText.includes("scroll-timeline") || r.cssText.includes("view-timeline")); } catch (e) { return false; } }))) libs.push("css-scroll-driven");
  if (probe(() => w.GPU && navigator.gpu)) libs.push("webgpu");

  // ---- keyframe rules declared anywhere readable (same-origin sheets; cross-origin ones are noted)
  const keyframes = [];
  const unreadableSheets = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { unreadableSheets.push(sheet.href || "(inline)"); continue; }
    const walk = (list) => {
      for (const rule of list) {
        if (rule.type === 7) keyframes.push({ name: rule.name, css: rule.cssText });
        else if (rule.cssRules) walk(rule.cssRules);
      }
    };
    walk(rules);
  }

  // ---- animations: CSS + WAAPI, with per-keyframe offsets and easings
  const animations = [];
  let list = [];
  try { list = root ? root.getAnimations({ subtree: true }) : document.getAnimations(); } catch (e) { list = []; }
  for (const anim of list.slice(0, 200)) {
    const effect = anim.effect;
    const target = effect && effect.target;
    let frames = [];
    try {
      frames = effect.getKeyframes().slice(0, 24).map((frame) => {
        const out = {};
        for (const [prop, value] of Object.entries(frame)) {
          if (prop === "computedOffset" || prop === "composite") continue;
          out[prop] = value;
        }
        return out;
      });
    } catch (e) {}
    let timing = null;
    try { timing = effect ? effect.getTiming() : null; } catch (e) {}
    animations.push({
      kind: anim.constructor.name,
      name: anim.animationName || anim.transitionProperty || anim.id || "",
      target: tagOf(target),
      targetPath: target && target.parentElement ? tagOf(target.parentElement) + " > " + tagOf(target) : null,
      timing,
      keyframes: frames,
      playState: anim.playState,
      currentTime: anim.currentTime,
      timeline: anim.timeline && anim.timeline.constructor.name,
      pseudoElement: effect && effect.pseudoElement ? effect.pseudoElement : null,
    });
  }

  // ---- transitions declared in styles
  const transitions = [];
  for (const el of root ? [root, ...root.querySelectorAll("*")].slice(0, 150) : []) {
    const cs = getComputedStyle(el);
    if (cs.transitionProperty && cs.transitionProperty !== "none" && cs.transitionDuration !== "0s") {
      transitions.push({ el: tagOf(el), property: cs.transitionProperty, duration: cs.transitionDuration, easing: cs.transitionTimingFunction, delay: cs.transitionDelay });
    }
  }

  // ---- computed styles of the key nodes in the subtree
  const PROPS = ["opacity", "transform", "transform-origin", "transition", "animation", "will-change", "color", "background-color", "background-image", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "border-radius", "box-shadow", "filter", "backdrop-filter", "clip-path", "overflow", "position", "display", "gap", "padding", "mask-image", "mix-blend-mode"];
  const SKIP = new Set(["none", "normal", "auto", "static", "visible", "0px", "all", "all 0s ease 0s", "rgba(0, 0, 0, 0)", "matrix(1, 0, 0, 1, 0, 0)", "1"]);
  const nodes = [];
  if (root) {
    for (const el of [root, ...root.querySelectorAll("*")].slice(0, 150)) {
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      const style = {};
      for (const prop of PROPS) {
        const value = cs.getPropertyValue(prop);
        if (!value || SKIP.has(value)) continue;
        style[prop] = value;
      }
      nodes.push({
        el: tagOf(el),
        rect: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
        text: el.childElementCount === 0 ? (el.textContent || "").trim().slice(0, 60) : undefined,
        style,
        src: el.currentSrc || el.src || undefined,
      });
    }
  }

  // ---- canvases, with the context type the page actually asked for
  const canvases = [...document.querySelectorAll("canvas")].map((c) => {
    const box = c.getBoundingClientRect();
    return {
      el: tagOf(c),
      context: c.__filmCtx || null,
      size: [c.width, c.height],
      css: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
      attributes: (() => { try { const gl = c.__filmCtx ? null : null; return undefined; } catch (e) { return undefined; } })(),
    };
  });
  if (canvases.some((c) => /webgl/.test(c.context || ""))) libs.push("webgl-canvas");
  if (canvases.some((c) => c.context === "webgpu")) libs.push("webgpu-canvas");
  if (canvases.some((c) => c.context === "2d")) libs.push("canvas2d");

  // ---- fonts that actually loaded
  const fonts = [];
  try {
    for (const face of document.fonts) {
      if (face.status !== "loaded") continue;
      fonts.push({ family: String(face.family).replace(/"/g, ""), weight: face.weight, style: face.style, status: face.status });
    }
  } catch (e) {}

  const rect = root ? root.getBoundingClientRect() : null;
  return {
    url: location.href,
    title: document.title,
    viewport: [innerWidth, innerHeight],
    scrollY: Math.round(window.scrollY),
    devicePixelRatio,
    libs,
    fonts,
    canvases,
    target: selector ? { selector, found: !!root, rect: rect && [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)] } : null,
    animations,
    transitions,
    keyframes,
    unreadableSheets: unreadableSheets.length ? unreadableSheets : undefined,
    nodes,
    scrollDriven: (() => {
      try {
        return list.filter((a) => a.timeline && a.timeline !== document.timeline).map((a) => ({ name: a.animationName || a.id || "", timeline: a.timeline.constructor.name, target: tagOf(a.effect && a.effect.target) }));
      } catch (e) { return []; }
    })(),
  };
}`;
