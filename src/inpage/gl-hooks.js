// refilm — in-page GPU tracer.
//
// Injected before any page script when a capture runs with --gl. Pixels are the only output of a canvas,
// but every call that produced them goes through a small API surface, so wrapping that surface records:
//
//   WebGL 1/2   shader sources, programs, attribute layouts, textures (with the URL they came from),
//               buffers, framebuffers, and per frame every draw call with program, primitive, vertex and
//               instance count, target framebuffer, bound textures, blend/depth/cull state, plus the
//               uniform values that changed since the previous draw of that program. Uniforms are the
//               animation channels of a GPU scene: a hover easing one from 0 to 1 over 600 ms is a curve.
//   three.js    the devtools entry point every build publishes: renderer settings, the scene graph and,
//               per render, camera / object transforms and material uniforms.
//   WebGPU      WGSL modules, pipelines, draw counts and small uniform-buffer writes.
//   Canvas 2D   call counts per frame and the full call list on sampled frames.
//
// window.__filmGl.export() hands all of it back; the record command turns that into gl/ + gl-track.json.
(function (cfg) {
  const root = self;
  if (root.__filmGl) return;

  const G = (root.__filmGl = {
    contexts: [],
    programs: [],
    shaders: [],
    textures: [],
    buffers: [],
    framebuffers: [],
    frames: [],
    notes: [],
    three: { revision: null, renderers: [], scenes: [], targets: [], mixers: [], loads: [] },
    webgpu: { modules: [], pipelines: [], buffers: [] },
    engines: { pixi: [], playcanvas: [], babylon: [], ogl: [] },
    current: null,
    inFrame: 0,
    frameNo: 0,
    dumped: 0,
  });

  const CAP_FRAMES = cfg.maxFrames || 1500;
  const CAP_DRAWS = cfg.maxDraws || 300;
  const CAP_OBJECTS = cfg.maxObjects || 250;
  const now = () => performance.now();
  const note = (where, err) => {
    if (G.notes.length < 50) G.notes.push(where + ": " + String((err && err.message) || err));
  };

  // ---------------------------------------------------------------- frames
  // A frame is one requestAnimationFrame timestamp; work that happens outside rAF joins the frame it is
  // nearest to in real time.
  function frameFor(ts) {
    if (G.current && G.current.ts === ts) return G.current;
    if (G.frameNo % 30 === 0) {
      try {
        scanEngines();
      } catch (e) {
        note("engine scan", e);
      }
    }
    return openFrame(ts);
  }
  function openFrame(ts) {
    if (G.frames.length >= CAP_FRAMES) {
      G.current = { overflow: true, ts, t: now(), draws: [], uniforms: {}, scene: {}, gpu: {}, pc: {}, canvas2d: null };
      return G.current;
    }
    G.current = {
      i: G.frameNo++,
      ts,
      t: now(),
      draws: [],
      uniforms: {},
      scene: {},
      gpu: {},
      pc: {},
      canvas2d: null,
      clears: [],
      dropped: 0,
    };
    G.frames.push(G.current);
    return G.current;
  }
  function frame() {
    if (G.inFrame && G.current) return G.current;
    if (G.current && now() - G.current.t < 8) return G.current;
    return openFrame(null);
  }
  if (root.requestAnimationFrame) {
    const raf = root.requestAnimationFrame;
    root.requestAnimationFrame = function requestAnimationFrame(cb) {
      return raf.call(this, function (ts) {
        frameFor(ts);
        G.inFrame++;
        try {
          return cb.apply(this, arguments);
        } finally {
          G.inFrame--;
        }
      });
    };
  }

  // ---------------------------------------------------------------- ids
  const tagged = new WeakMap();
  const seq = {};
  function tag(obj, kind, init) {
    if (!obj) return null;
    let rec = tagged.get(obj);
    if (!rec) {
      seq[kind] = (seq[kind] || 0) + 1;
      rec = Object.assign({ id: (cfg.prefix || "") + kind + seq[kind] }, init || {});
      tagged.set(obj, rec);
    }
    return rec;
  }
  const tidy = (v) =>
    typeof v === "number" ? (Number.isInteger(v) ? v : +v.toPrecision(6)) : typeof v === "boolean" ? +v : v;

  function labelElement(el) {
    if (!el) return null;
    if (typeof OffscreenCanvas !== "undefined" && el instanceof OffscreenCanvas) return "OffscreenCanvas";
    let s = (el.tagName || "?").toLowerCase();
    if (el.id) s += "#" + el.id;
    if (el.classList && el.classList.length) s += "." + Array.prototype.slice.call(el.classList, 0, 3).join(".");
    return s;
  }

  // ---------------------------------------------------------------- contexts
  function registerContext(ctx, canvas, kind, requested) {
    if (tagged.has(ctx)) return;
    const type = /webgl2/.test(kind) ? "webgl2" : /webgl/.test(kind) ? "webgl" : kind;
    const rec = tag(ctx, "c", { type, canvas: labelElement(canvas), requested: requested || null, created: now() });
    rec._ctx = ctx;
    rec._canvas = canvas;
    rec.state = {
      program: null,
      framebuffer: 0,
      vao: 0,
      arrayBuffer: null,
      elementBuffer: null,
      unit: 0,
      units: {},
      caps: {},
      blend: "SRC_ALPHA,ONE_MINUS_SRC_ALPHA",
      equation: "ADD",
      viewport: null,
      clearColor: [0, 0, 0, 0],
      attribs: { 0: {} },
    };
    G.contexts.push(rec);
  }
  for (const C of [root.HTMLCanvasElement, root.OffscreenCanvas]) {
    if (!C) continue;
    const orig = C.prototype.getContext;
    C.prototype.getContext = function getContext(type) {
      const ctx = orig.apply(this, arguments);
      if (ctx) {
        try {
          registerContext(ctx, this, String(type), arguments[1]);
        } catch (e) {
          note("getContext", e);
        }
      }
      return ctx;
    };
  }

  // ---------------------------------------------------------------- WebGL
  const BLEND = {
    0: "ZERO",
    1: "ONE",
    0x300: "SRC_COLOR",
    0x301: "ONE_MINUS_SRC_COLOR",
    0x302: "SRC_ALPHA",
    0x303: "ONE_MINUS_SRC_ALPHA",
    0x304: "DST_ALPHA",
    0x305: "ONE_MINUS_DST_ALPHA",
    0x306: "DST_COLOR",
    0x307: "ONE_MINUS_DST_COLOR",
    0x308: "SRC_ALPHA_SATURATE",
    0x8001: "CONSTANT_COLOR",
    0x8002: "ONE_MINUS_CONSTANT_COLOR",
    0x8003: "CONSTANT_ALPHA",
    0x8004: "ONE_MINUS_CONSTANT_ALPHA",
  };
  const EQUATION = { 0x8006: "ADD", 0x800a: "SUBTRACT", 0x800b: "REVERSE_SUBTRACT", 0x8007: "MIN", 0x8008: "MAX" };
  const PRIMITIVE = ["POINTS", "LINES", "LINE_LOOP", "LINE_STRIP", "TRIANGLES", "TRIANGLE_STRIP", "TRIANGLE_FAN"];
  const GL_TYPE = {
    0x1406: "float",
    0x8b50: "vec2",
    0x8b51: "vec3",
    0x8b52: "vec4",
    0x1404: "int",
    0x8b53: "ivec2",
    0x8b54: "ivec3",
    0x8b55: "ivec4",
    0x8b56: "bool",
    0x8b57: "bvec2",
    0x8b58: "bvec3",
    0x8b59: "bvec4",
    0x8b5a: "mat2",
    0x8b5b: "mat3",
    0x8b5c: "mat4",
    0x8b5e: "sampler2D",
    0x8b5f: "sampler3D",
    0x8b60: "samplerCube",
    0x8b62: "sampler2DShadow",
    0x8dc1: "sampler2DArray",
    0x1405: "uint",
    0x8dc6: "uvec2",
    0x8dc7: "uvec3",
    0x8dc8: "uvec4",
    0x8b65: "mat2x3",
    0x8b66: "mat2x4",
    0x8b67: "mat3x2",
    0x8b68: "mat3x4",
    0x8b69: "mat4x2",
    0x8b6a: "mat4x3",
    0x8dca: "isampler2D",
    0x8dd2: "usampler2D",
  };
  const CAP = { 0x0be2: "BLEND", 0x0b71: "DEPTH_TEST", 0x0b44: "CULL_FACE", 0x0b90: "STENCIL_TEST", 0x0c11: "SCISSOR_TEST" };
  const DATA_TYPE = {
    0x1400: "BYTE",
    0x1401: "UNSIGNED_BYTE",
    0x1402: "SHORT",
    0x1403: "UNSIGNED_SHORT",
    0x1404: "INT",
    0x1405: "UNSIGNED_INT",
    0x1406: "FLOAT",
    0x140b: "HALF_FLOAT",
    0x8d61: "HALF_FLOAT_OES",
  };
  const stateOf = (gl) => {
    const rec = tagged.get(gl);
    return rec && rec.state;
  };

  function describeSource(src) {
    if (!src || typeof src !== "object") return null;
    try {
      if (root.HTMLImageElement && src instanceof HTMLImageElement)
        return { kind: "img", url: src.currentSrc || src.src, w: src.naturalWidth, h: src.naturalHeight };
      if (root.HTMLVideoElement && src instanceof HTMLVideoElement)
        return { kind: "video", url: src.currentSrc || src.src, w: src.videoWidth, h: src.videoHeight };
      if (root.HTMLCanvasElement && src instanceof HTMLCanvasElement)
        return { kind: "canvas", el: labelElement(src), w: src.width, h: src.height, _el: src };
      if (root.OffscreenCanvas && src instanceof OffscreenCanvas)
        return { kind: "offscreen", w: src.width, h: src.height, _el: src };
      if (root.ImageBitmap && src instanceof ImageBitmap) return { kind: "bitmap", w: src.width, h: src.height, url: src.__filmUrl };
      if (root.ImageData && src instanceof ImageData) return { kind: "imagedata", w: src.width, h: src.height };
      if (root.VideoFrame && src instanceof VideoFrame) return { kind: "videoframe", w: src.displayWidth, h: src.displayHeight };
      if (ArrayBuffer.isView(src)) return { kind: "data", type: src.constructor.name, bytes: src.byteLength };
    } catch (e) {
      note("describeSource", e);
    }
    return { kind: typeof src };
  }

  function patch(proto, name, after) {
    const orig = proto && proto[name];
    if (typeof orig !== "function" || orig.__film) return;
    const wrapped = function () {
      const out = orig.apply(this, arguments);
      try {
        after.call(this, out, arguments);
      } catch (e) {
        note(name, e);
      }
      return out;
    };
    wrapped.__film = true;
    proto[name] = wrapped;
  }

  function onDraw(gl, primitive, count, instances) {
    const st = stateOf(gl);
    if (!st || !st.program) return;
    const p = st.program;
    p.draws++;
    p.primitives[PRIMITIVE[primitive] || primitive] = 1;
    if (count > p.maxCount) p.maxCount = count;
    if (instances && instances > p.maxInstances) p.maxInstances = instances;
    if (!p.layout) p.layout = attributeLayout(st, p);
    const f = frame();
    if (f.overflow) return;
    const ordinal = (f.pc[p.id] = (f.pc[p.id] || 0) + 1) - 1;
    if (f.draws.length >= CAP_DRAWS) {
      f.dropped++;
      return;
    }
    const bound = [];
    for (let u = 0; u < 8; u++) if (st.units[u]) bound[u] = st.units[u];
    const state =
      (st.caps.BLEND ? "blend " + st.blend + (st.equation !== "ADD" ? " " + st.equation : "") : "no-blend") +
      (st.caps.DEPTH_TEST ? " depth" : "") +
      (st.caps.CULL_FACE ? " cull" : "") +
      (st.depthWrite === false ? " no-depth-write" : "");
    if (!p.state) p.state = state;
    f.draws.push({
      c: tagged.get(gl).id,
      p: p.id,
      m: PRIMITIVE[primitive] || primitive,
      n: count,
      i: instances || undefined,
      fb: st.framebuffer,
      tx: bound.length ? bound : undefined,
      st: state,
      vp: st.viewport ? st.viewport.join(",") : undefined,
    });
    // uniform deltas since the previous draw of this program at the same ordinal
    const key = p.id + "#" + ordinal;
    const last = (p.previous[ordinal] = p.previous[ordinal] || {});
    let delta = null;
    for (const name in p.values) {
      const v = p.values[name];
      const prev = last[name];
      let same = !!prev && prev.length === v.length;
      if (same) for (let k = 0; k < v.length; k++) if (prev[k] !== v[k]) { same = false; break; }
      if (!same) {
        (delta || (delta = {}))[name] = v;
        last[name] = v;
      }
    }
    if (delta) f.uniforms[key] = delta;
  }

  function attributeLayout(st, p) {
    const out = [];
    const table = st.attribs[st.vao] || {};
    for (const idx in p.attribs) {
      const bound = table[idx];
      out.push(
        Object.assign(
          { name: p.attribs[idx], index: +idx },
          bound
            ? {
                buffer: bound.buf,
                size: bound.size,
                type: DATA_TYPE[bound.type] || bound.type,
                normalized: !!bound.norm,
                stride: bound.stride,
                offset: bound.off,
                divisor: bound.div || undefined,
              }
            : { constant: true },
        ),
      );
    }
    return out;
  }

  const UNIFORM_SCALARS = ["uniform1f", "uniform2f", "uniform3f", "uniform4f", "uniform1i", "uniform2i", "uniform3i", "uniform4i", "uniform1ui", "uniform2ui", "uniform3ui", "uniform4ui"];
  const UNIFORM_VECTORS = ["uniform1fv", "uniform2fv", "uniform3fv", "uniform4fv", "uniform1iv", "uniform2iv", "uniform3iv", "uniform4iv", "uniform1uiv", "uniform2uiv", "uniform3uiv", "uniform4uiv"];
  const UNIFORM_MATRICES = ["uniformMatrix2fv", "uniformMatrix3fv", "uniformMatrix4fv", "uniformMatrix2x3fv", "uniformMatrix3x2fv", "uniformMatrix2x4fv", "uniformMatrix4x2fv", "uniformMatrix3x4fv", "uniformMatrix4x3fv"];
  const locations = new WeakMap();
  const textureById = new Map();
  const sliceOf = (data, off, len) =>
    Array.prototype.slice.call(data, off || 0, len ? (off || 0) + len : undefined);

  function setUniform(loc, values) {
    const target = locations.get(loc);
    if (!target) return;
    target.p.values[target.name] = values.length > 64 ? values.slice(0, 64).map(tidy) : values.map(tidy);
    if (values.length > 64) target.p.truncated[target.name] = values.length;
  }

  function hookWebGL(proto) {
    if (!proto) return;
    patch(proto, "createShader", function (sh, [type]) {
      const rec = tag(sh, "s", { type: type === 0x8b31 ? "vertex" : "fragment", src: null });
      G.shaders.push(rec);
    });
    patch(proto, "shaderSource", function (_, [sh, src]) {
      const rec = tagged.get(sh);
      if (rec) rec.src = src;
    });
    patch(proto, "createProgram", function (program) {
      const rec = tag(program, "p", {
        vs: null,
        fs: null,
        links: 0,
        draws: 0,
        primitives: {},
        maxCount: 0,
        maxInstances: 0,
        attribs: {},
        values: {},
        truncated: {},
        previous: [],
        label: null,
        ctx: tagged.get(this) && tagged.get(this).id,
      });
      rec._gl = this;
      rec._program = program;
      G.programs.push(rec);
    });
    patch(proto, "attachShader", function (_, [program, sh]) {
      const p = tagged.get(program);
      const s = tagged.get(sh);
      if (p && s) p[s.type === "vertex" ? "vs" : "fs"] = s;
    });
    patch(proto, "linkProgram", function (_, [program]) {
      const p = tagged.get(program);
      if (!p) return;
      p.links++;
      p.vsSource = p.vs && p.vs.src;
      p.fsSource = p.fs && p.fs.src;
      const named = /#define SHADER_NAME (.+)/.exec(p.vsSource || "") || /#define SHADER_NAME (.+)/.exec(p.fsSource || "");
      if (named && !p.label) p.label = named[1].trim();
      p.linkedAt = now();
    });
    patch(proto, "deleteProgram", function (_, [program]) {
      const p = tagged.get(program);
      if (p) p.deleted = true;
    });
    patch(proto, "useProgram", function (_, [program]) {
      const st = stateOf(this);
      if (st) st.program = tagged.get(program) || null;
    });
    patch(proto, "getUniformLocation", function (loc, [program, name]) {
      const p = tagged.get(program);
      if (loc && p) locations.set(loc, { p, name: String(name).replace(/\[0\]$/, "") });
    });
    patch(proto, "getAttribLocation", function (idx, [program, name]) {
      const p = tagged.get(program);
      if (p && idx >= 0) p.attribs[idx] = name;
    });
    patch(proto, "bindAttribLocation", function (_, [program, idx, name]) {
      const p = tagged.get(program);
      if (p) p.attribs[idx] = name;
    });
    for (const name of UNIFORM_SCALARS)
      patch(proto, name, function (_, args) {
        setUniform(args[0], Array.prototype.slice.call(args, 1));
      });
    for (const name of UNIFORM_VECTORS)
      patch(proto, name, function (_, args) {
        setUniform(args[0], sliceOf(args[1], args[2], args[3]));
      });
    for (const name of UNIFORM_MATRICES)
      patch(proto, name, function (_, args) {
        setUniform(args[0], sliceOf(args[2], args[3], args[4]));
      });

    patch(proto, "drawArrays", function (_, a) {
      onDraw(this, a[0], a[2], 0);
    });
    patch(proto, "drawElements", function (_, a) {
      onDraw(this, a[0], a[1], 0);
    });
    patch(proto, "drawArraysInstanced", function (_, a) {
      onDraw(this, a[0], a[2], a[3]);
    });
    patch(proto, "drawElementsInstanced", function (_, a) {
      onDraw(this, a[0], a[1], a[4]);
    });
    patch(proto, "drawRangeElements", function (_, a) {
      onDraw(this, a[0], a[3], 0);
    });

    patch(proto, "createFramebuffer", function (fb) {
      G.framebuffers.push(tag(fb, "f", { color: null }));
    });
    patch(proto, "bindFramebuffer", function (_, [target, fb]) {
      const st = stateOf(this);
      if (st && target !== 0x8ca8) st.framebuffer = fb ? tag(fb, "f", { color: null }).id : 0; // skip READ_FRAMEBUFFER
    });
    patch(proto, "framebufferTexture2D", function (_, [, attachment, , tex]) {
      const st = stateOf(this);
      const fb = st && st.framebuffer && G.framebuffers.find((x) => x.id === st.framebuffer);
      if (fb && attachment === 0x8ce0) fb.color = tex ? tag(tex, "t", {}).id : null;
    });
    patch(proto, "activeTexture", function (_, [unit]) {
      const st = stateOf(this);
      if (st) st.unit = unit - 0x84c0;
    });
    patch(proto, "createTexture", function (tex) {
      const rec = tag(tex, "t", { uploads: 0 });
      G.textures.push(rec);
      textureById.set(rec.id, rec);
    });
    patch(proto, "bindTexture", function (_, [, tex]) {
      const st = stateOf(this);
      if (st) st.units[st.unit] = tex ? tag(tex, "t", { uploads: 0 }).id : undefined;
    });

    const textureUpload = function (args, storage) {
      const st = stateOf(this);
      if (!st) return;
      const id = st.units[st.unit];
      const tex = id && textureById.get(id);
      if (!tex) return;
      tex.uploads = (tex.uploads || 0) + 1;
      if (tex.uploads > 1 && tex.src && tex.src.kind !== "storage" && tex.src.kind !== "empty") return;
      if (storage) {
        tex.w = args[3];
        tex.h = args[4];
        tex.src = tex.src || { kind: "storage" };
        return;
      }
      if (args[1] !== 0) return; // mip level
      let src = null;
      for (let k = args.length - 1; k >= 5; k--)
        if (args[k] && typeof args[k] === "object") {
          src = args[k];
          break;
        }
      if (args.length === 6 && typeof args[5] === "object") src = args[5];
      tex.src = describeSource(src) || { kind: "empty" };
      if (args.length >= 8 && typeof args[3] === "number") {
        tex.w = args[3];
        tex.h = args[4];
      } else if (tex.src) {
        tex.w = tex.src.w;
        tex.h = tex.src.h;
      }
    };
    patch(proto, "texImage2D", function (_, a) {
      textureUpload.call(this, a, false);
    });
    patch(proto, "texStorage2D", function (_, a) {
      textureUpload.call(this, a, true);
    });
    patch(proto, "texStorage3D", function (_, a) {
      textureUpload.call(this, a, true);
    });
    // WebGL2 libraries allocate with texStorage2D and then upload the image with texSubImage2D
    const subUpload = function (args, volume) {
      const st = stateOf(this);
      const id = st && st.units[st.unit];
      const tex = id && textureById.get(id);
      if (!tex || args[1] !== 0) return;
      tex.uploads = (tex.uploads || 0) + 1;
      if (tex.src && tex.src.kind !== "storage" && tex.src.kind !== "empty") return;
      let src = null;
      for (let k = args.length - 1; k >= 4; k--)
        if (args[k] && typeof args[k] === "object") {
          src = args[k];
          break;
        }
      const described = describeSource(src);
      if (described) {
        tex.src = described;
        if (!tex.w) {
          tex.w = described.w;
          tex.h = described.h;
        }
        if (volume) tex.depth = args[6];
      }
    };
    patch(proto, "texSubImage2D", function (_, a) {
      subUpload.call(this, a, false);
    });
    patch(proto, "texImage3D", function (_, a) {
      const st = stateOf(this);
      const id = st && st.units[st.unit];
      const tex = id && textureById.get(id);
      if (tex && a[1] === 0) {
        tex.uploads = (tex.uploads || 0) + 1;
        tex.w = a[3];
        tex.h = a[4];
        tex.depth = a[5];
        let src = null;
        for (let k = a.length - 1; k >= 8; k--)
          if (a[k] && typeof a[k] === "object") {
            src = a[k];
            break;
          }
        tex.src = describeSource(src) || { kind: "empty" };
      }
    });
    patch(proto, "texSubImage3D", function (_, a) {
      subUpload.call(this, a, true);
    });
    patch(proto, "compressedTexImage2D", function (_, a) {
      const st = stateOf(this);
      const id = st && st.units[st.unit];
      const tex = id && textureById.get(id);
      if (tex) {
        tex.uploads = (tex.uploads || 0) + 1;
        tex.w = a[3];
        tex.h = a[4];
        tex.src = tex.src || { kind: "compressed" };
      }
    });

    patch(proto, "createBuffer", function (buf) {
      G.buffers.push(tag(buf, "b", { uploads: 0 }));
    });
    patch(proto, "bindBuffer", function (_, [target, buf]) {
      const st = stateOf(this);
      if (!st) return;
      if (target === 0x8892) st.arrayBuffer = buf ? tag(buf, "b", { uploads: 0 }).id : null;
      else if (target === 0x8893) st.elementBuffer = buf ? tag(buf, "b", { uploads: 0 }).id : null;
    });
    patch(proto, "bufferData", function (_, [target, data, usage, srcOffset, length]) {
      const st = stateOf(this);
      const id = st && (target === 0x8893 ? st.elementBuffer : st.arrayBuffer);
      const buf = id && G.buffers.find((x) => x.id === id);
      if (!buf) return;
      buf.uploads++;
      buf.target = target === 0x8893 ? "ELEMENT_ARRAY_BUFFER" : target === 0x8892 ? "ARRAY_BUFFER" : target;
      buf.usage = { 0x88e4: "STATIC_DRAW", 0x88e8: "DYNAMIC_DRAW", 0x88e0: "STREAM_DRAW" }[usage] || usage;
      if (typeof data === "number") {
        buf.bytes = data;
        return;
      }
      if (!data) return;
      const view = ArrayBuffer.isView(data) ? data : new Uint8Array(data);
      buf.type = view.constructor.name;
      buf.bytes = view.byteLength;
      if (buf.uploads === 1) {
        buf.sample = Array.prototype.slice.call(view, 0, 24).map(tidy);
        if (cfg.dumpBuffers && G.dumped + view.byteLength <= cfg.dumpBuffers) {
          buf._dump = view.slice(srcOffset || 0, length ? (srcOffset || 0) + length : undefined);
          G.dumped += buf._dump.byteLength;
        }
      }
    });
    patch(proto, "bufferSubData", function (_, [target]) {
      const st = stateOf(this);
      const id = st && (target === 0x8893 ? st.elementBuffer : st.arrayBuffer);
      const buf = id && G.buffers.find((x) => x.id === id);
      if (buf) buf.subUploads = (buf.subUploads || 0) + 1;
    });
    const attributePointer = function (args, strided) {
      const st = stateOf(this);
      if (!st) return;
      const idx = args[0];
      const table = (st.attribs[st.vao] = st.attribs[st.vao] || {});
      const next = strided
        ? { buf: st.arrayBuffer, size: args[1], type: args[2], stride: args[3], off: args[4] }
        : { buf: st.arrayBuffer, size: args[1], type: args[2], norm: args[3], stride: args[4], off: args[5] };
      table[idx] = Object.assign(table[idx] || {}, next);
    };
    patch(proto, "vertexAttribPointer", function (_, a) {
      attributePointer.call(this, a, false);
    });
    patch(proto, "vertexAttribIPointer", function (_, a) {
      attributePointer.call(this, a, true);
    });
    patch(proto, "vertexAttribDivisor", function (_, [idx, divisor]) {
      const st = stateOf(this);
      if (st) {
        const table = (st.attribs[st.vao] = st.attribs[st.vao] || {});
        table[idx] = Object.assign(table[idx] || {}, { div: divisor });
      }
    });
    patch(proto, "bindVertexArray", function (_, [vao]) {
      const st = stateOf(this);
      if (st) st.vao = vao ? tag(vao, "v", {}).id : 0;
    });

    patch(proto, "enable", function (_, [cap]) {
      const st = stateOf(this);
      if (st && CAP[cap]) st.caps[CAP[cap]] = true;
    });
    patch(proto, "disable", function (_, [cap]) {
      const st = stateOf(this);
      if (st && CAP[cap]) st.caps[CAP[cap]] = false;
    });
    patch(proto, "blendFunc", function (_, [src, dst]) {
      const st = stateOf(this);
      if (st) st.blend = (BLEND[src] || src) + "," + (BLEND[dst] || dst);
    });
    patch(proto, "blendFuncSeparate", function (_, a) {
      const st = stateOf(this);
      if (st) st.blend = a.map((x) => BLEND[x] || x).join(",");
    });
    patch(proto, "blendEquation", function (_, [mode]) {
      const st = stateOf(this);
      if (st) st.equation = EQUATION[mode] || mode;
    });
    patch(proto, "blendEquationSeparate", function (_, [a, b]) {
      const st = stateOf(this);
      if (st) st.equation = a === b ? EQUATION[a] || a : (EQUATION[a] || a) + "," + (EQUATION[b] || b);
    });
    patch(proto, "depthMask", function (_, [mask]) {
      const st = stateOf(this);
      if (st) st.depthWrite = !!mask;
    });
    patch(proto, "viewport", function (_, a) {
      const st = stateOf(this);
      if (st) st.viewport = [a[0], a[1], a[2], a[3]];
    });
    patch(proto, "clearColor", function (_, a) {
      const st = stateOf(this);
      if (st) st.clearColor = [a[0], a[1], a[2], a[3]].map(tidy);
    });
    patch(proto, "clear", function (_, [mask]) {
      const st = stateOf(this);
      if (!st) return;
      const f = frame();
      if (!f.overflow && f.clears.length < 32) f.clears.push({ fb: st.framebuffer, color: mask & 0x4000 ? st.clearColor : undefined });
    });

    patch(proto, "getExtension", function (ext, [name]) {
      const rec = tagged.get(this);
      if (rec) (rec.extensions = rec.extensions || {})[name] = !!ext;
      if (!ext || ext.__filmWrapped) return;
      ext.__filmWrapped = true;
      const gl = this;
      if (name === "ANGLE_instanced_arrays") {
        patch(ext, "drawArraysInstancedANGLE", function (_, a) {
          onDraw(gl, a[0], a[2], a[3]);
        });
        patch(ext, "drawElementsInstancedANGLE", function (_, a) {
          onDraw(gl, a[0], a[1], a[4]);
        });
        patch(ext, "vertexAttribDivisorANGLE", function (_, [idx, divisor]) {
          const st = stateOf(gl);
          if (st) {
            const table = (st.attribs[st.vao] = st.attribs[st.vao] || {});
            table[idx] = Object.assign(table[idx] || {}, { div: divisor });
          }
        });
      }
      if (name === "OES_vertex_array_object")
        patch(ext, "bindVertexArrayOES", function (_, [vao]) {
          const st = stateOf(gl);
          if (st) st.vao = vao ? tag(vao, "v", {}).id : 0;
        });
    });
  }
  hookWebGL(root.WebGLRenderingContext && WebGLRenderingContext.prototype);
  hookWebGL(root.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

  // A bitmap made from a fetched blob loses its URL; keep it when the blob came from a Response.
  if (root.Response && root.createImageBitmap) {
    const blob = Response.prototype.blob;
    Response.prototype.blob = function () {
      const url = this.url;
      return blob.apply(this, arguments).then((b) => {
        try {
          b.__filmUrl = url;
        } catch (e) {}
        return b;
      });
    };
    const create = root.createImageBitmap;
    root.createImageBitmap = function (src) {
      return create.apply(this, arguments).then((bm) => {
        try {
          if (src && src.__filmUrl) bm.__filmUrl = src.__filmUrl;
          else if (src && src.currentSrc) bm.__filmUrl = src.currentSrc;
        } catch (e) {}
        return bm;
      });
    };
  }

  // ---------------------------------------------------------------- three.js
  const T = G.three;
  const objectIds = new WeakMap();
  let objectSeq = 0;
  const oid = (o) => {
    let i = objectIds.get(o);
    if (!i) {
      i = ++objectSeq;
      objectIds.set(o, i);
    }
    return i;
  };
  const label = (o) => (o.name ? o.name.replace(/[.\s#:]+/g, "_") : o.type || "Object3D") + "#" + oid(o);
  const lastValues = {};
  function channel(f, key, v) {
    if (typeof v === "boolean") v = +v;
    if (typeof v !== "number" || !isFinite(v)) return;
    v = tidy(v);
    if (lastValues[key] !== v) {
      lastValues[key] = v;
      f.scene[key] = v;
    }
  }
  function uniformChannel(f, key, v) {
    if (v === null || v === undefined) return;
    if (typeof v === "number" || typeof v === "boolean") return channel(f, key, v);
    if (v.isColor) {
      channel(f, key + ".r", v.r);
      channel(f, key + ".g", v.g);
      channel(f, key + ".b", v.b);
      return;
    }
    if (v.isVector2 || v.isVector3 || v.isVector4 || v.isQuaternion) {
      for (const c of ["x", "y", "z", "w"]) if (c in v) channel(f, key + "." + c, v[c]);
      return;
    }
    if (v.isMatrix3 || v.isMatrix4) {
      v.elements.forEach((e, k) => channel(f, key + "[" + k + "]", e));
      return;
    }
    if (Array.isArray(v) && v.length <= 16 && typeof v[0] === "number") v.forEach((e, k) => channel(f, key + "[" + k + "]", e));
  }
  function transformChannels(f, key, o) {
    for (const c of ["x", "y", "z"]) channel(f, key + ".position." + c, o.position[c]);
    for (const c of ["x", "y", "z"]) channel(f, key + ".rotation." + c, o.rotation[c]);
    for (const c of ["x", "y", "z"]) channel(f, key + ".scale." + c, o.scale[c]);
    channel(f, key + ".visible", o.visible);
  }
  function recordRender(renderer, scene, camera) {
    const f = frame();
    if (f.overflow || !scene) return;
    let index = T.scenes.indexOf(scene);
    if (index < 0) {
      T.scenes.push(scene);
      index = T.scenes.length - 1;
    }
    const target = renderer.getRenderTarget ? renderer.getRenderTarget() : null;
    let targetIndex = 0;
    if (target) {
      targetIndex = T.targets.indexOf(target) + 1;
      if (!targetIndex) {
        T.targets.push(target);
        targetIndex = T.targets.length;
      }
    }
    (f.three = f.three || []).push({ engine: "three", scene: index, camera: camera ? label(camera) : null, target: targetIndex });
    const prefix = "three:s" + index + "/";
    if (camera) {
      const ck = prefix + "cam:" + label(camera);
      transformChannels(f, ck, camera);
      for (const k of ["fov", "zoom", "near", "far", "left", "right", "top", "bottom"]) if (k in camera) channel(f, ck + "." + k, camera[k]);
    }
    let seen = 0;
    const materials = new Set();
    scene.traverse((o) => {
      if (seen >= CAP_OBJECTS || o === scene) return;
      seen++;
      const key = prefix + label(o);
      transformChannels(f, key, o);
      if (o.morphTargetInfluences) o.morphTargetInfluences.slice(0, 8).forEach((v, i) => channel(f, key + ".morph[" + i + "]", v));
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        if (materials.has(m)) continue;
        materials.add(m);
        const mk = prefix + "mat:" + label(m);
        channel(f, mk + ".opacity", m.opacity);
        if (m.color) uniformChannel(f, mk + ".color", m.color);
        if (m.emissive) uniformChannel(f, mk + ".emissive", m.emissive);
        if (m.uniforms) for (const name in m.uniforms) uniformChannel(f, mk + "." + name, m.uniforms[name] && m.uniforms[name].value);
      }
    });
  }
  function hookRenderer(renderer) {
    if (T.renderers.includes(renderer)) return;
    T.renderers.push(renderer);
    const orig = renderer.render;
    if (typeof orig !== "function" || orig.__film) return;
    const wrapped = function (scene, camera) {
      try {
        recordRender(this, scene, camera);
      } catch (e) {
        note("three.render", e);
      }
      return orig.apply(this, arguments);
    };
    wrapped.__film = true;
    renderer.render = wrapped;
  }
  function hookLoader(loader) {
    const load = loader.load;
    if (typeof load !== "function" || load.__film) return;
    const wrapped = function (url) {
      try {
        if (T.loads.length < 200) T.loads.push({ loader: loader.constructor && loader.constructor.name, url: String(url) });
      } catch (e) {}
      return load.apply(this, arguments);
    };
    wrapped.__film = true;
    loader.load = wrapped;
  }
  try {
    const devtools = root.__THREE_DEVTOOLS__ || (root.__THREE_DEVTOOLS__ = new EventTarget());
    devtools.addEventListener("register", (e) => {
      T.revision = e.detail && e.detail.revision;
    });
    devtools.addEventListener("observe", (e) => {
      const o = e.detail;
      if (!o) return;
      if (o.isScene) {
        if (!T.scenes.includes(o)) T.scenes.push(o);
      } else if (o.isWebGLRenderer || o.isWebGPURenderer || o.isRenderer || (typeof o.render === "function" && o.domElement))
        queueMicrotask(() => hookRenderer(o));
      else if (typeof o.clipAction === "function") T.mixers.push(o); // AnimationMixer: its clips are keyframe data
      else if (typeof o.load === "function" && "manager" in o) hookLoader(o); // Loader: which files became the scene
    });
  } catch (e) {
    note("three devtools hook", e);
  }

  // ---------------------------------------------------------------- other engines
  // Each hook is the engine's own devtools entry point, so it works on bundled builds with no globals.
  const named = (o, fallback) => String((o && (o.label || o.name)) || fallback).replace(/[.\s#:/]+/g, "_");

  function pixiSample(stage) {
    const f = frame();
    if (f.overflow || !stage) return;
    let n = 0;
    const walk = (o, path) => {
      if (n++ >= CAP_OBJECTS) return;
      const key = "pixi:" + path + named(o, o.constructor && o.constructor.name) + "#" + oid(o);
      for (const p of ["x", "y", "rotation", "alpha", "visible"]) channel(f, key + "." + p, o[p]);
      if (o.scale) {
        channel(f, key + ".scale.x", o.scale.x);
        channel(f, key + ".scale.y", o.scale.y);
      }
      if (o.children) for (const child of o.children) walk(child, "");
    };
    walk(stage, "");
    (f.three = f.three || []).push({ engine: "pixi" });
  }
  root.__PIXI_APP_INIT__ = function (app, version) {
    G.engines.pixi.push({ version, app });
  };
  root.__PIXI_RENDERER_INIT__ = function (renderer, version) {
    G.engines.pixi.push({ version, renderer });
    const render = renderer.render;
    if (typeof render === "function" && !render.__film) {
      const wrapped = function (opts) {
        try {
          pixiSample(opts && opts.container ? opts.container : opts);
        } catch (e) {
          note("pixi", e);
        }
        return render.apply(this, arguments);
      };
      wrapped.__film = true;
      renderer.render = wrapped;
    }
  };

  try {
    root[Symbol.for("playcanvas.inspector")] = {
      register(app, info) {
        G.engines.playcanvas.push({ version: info && info.version, app });
        if (!app.on) return;
        app.on("framerender", () => {
          const f = frame();
          if (f.overflow) return;
          let n = 0;
          const walk = (entity) => {
            if (n++ >= CAP_OBJECTS) return;
            const key = "playcanvas:" + named(entity, "Entity") + "#" + oid(entity);
            const pos = entity.getLocalPosition && entity.getLocalPosition();
            const rot = entity.getLocalEulerAngles && entity.getLocalEulerAngles();
            const scale = entity.getLocalScale && entity.getLocalScale();
            if (pos) for (const c of ["x", "y", "z"]) channel(f, key + ".position." + c, pos[c]);
            if (rot) for (const c of ["x", "y", "z"]) channel(f, key + ".rotation." + c, rot[c]);
            if (scale) for (const c of ["x", "y", "z"]) channel(f, key + ".scale." + c, scale[c]);
            channel(f, key + ".enabled", entity.enabled);
            for (const child of entity.children || []) walk(child);
          };
          try {
            walk(app.root);
          } catch (e) {
            note("playcanvas", e);
          }
          (f.three = f.three || []).push({ engine: "playcanvas" });
        });
      },
      unregister() {},
    };
  } catch (e) {
    note("playcanvas hook", e);
  }

  function babylonScenes() {
    const B = root.BABYLON;
    if (!B || !B.Engine || !B.Engine.Instances) return;
    for (const engine of B.Engine.Instances)
      for (const scene of engine.scenes || []) {
        if (scene.__filmHooked) continue;
        scene.__filmHooked = true;
        G.engines.babylon.push({ version: B.Engine.Version, scene });
        scene.onBeforeRenderObservable.add(() => {
          const f = frame();
          if (f.overflow) return;
          let n = 0;
          const nodes = [].concat(scene.activeCamera ? [scene.activeCamera] : [], scene.meshes || [], scene.transformNodes || []);
          for (const node of nodes) {
            if (n++ >= CAP_OBJECTS) break;
            const key = "babylon:" + named(node, node.getClassName ? node.getClassName() : "Node") + "#" + oid(node);
            for (const prop of ["position", "rotation", "scaling"])
              if (node[prop]) for (const c of ["x", "y", "z"]) channel(f, key + "." + prop + "." + c, node[prop][c]);
            for (const prop of ["alpha", "beta", "radius", "visibility"]) if (prop in node) channel(f, key + "." + prop, node[prop]);
          }
          (f.three = f.three || []).push({ engine: "babylon" });
        });
      }
  }

  // OGL stores its renderer on the context it created; wrap its render({ scene, camera })
  function oglCheck(gl) {
    const renderer = gl && gl.renderer;
    if (!renderer || renderer.__film || typeof renderer.render !== "function") return;
    renderer.__film = true;
    G.engines.ogl.push({ renderer });
    const render = renderer.render;
    renderer.render = function (opts) {
      try {
        const f = frame();
        const scene = opts && opts.scene;
        if (!f.overflow && scene && scene.traverse) {
          let n = 0;
          const nodes = [];
          if (opts.camera) nodes.push(opts.camera);
          scene.traverse((o) => {
            if (n++ < CAP_OBJECTS) nodes.push(o);
          });
          for (const o of nodes) {
            const key = "ogl:" + named(o, o.constructor && o.constructor.name) + "#" + oid(o);
            for (const prop of ["position", "rotation", "scale"])
              if (o[prop])
                for (const c of ["x", "y", "z"]) channel(f, key + "." + prop + "." + c, o[prop][c] !== undefined ? o[prop][c] : o[prop][["x", "y", "z"].indexOf(c)]);
            if ("visible" in o) channel(f, key + ".visible", o.visible);
            const uniforms = o.program && o.program.uniforms;
            if (uniforms)
              for (const name in uniforms) {
                const v = uniforms[name] && uniforms[name].value;
                if (typeof v === "number") channel(f, key + ".u." + name, v);
                else if (v && v.length <= 4 && typeof v[0] === "number") for (let i = 0; i < v.length; i++) channel(f, key + ".u." + name + "[" + i + "]", v[i]);
              }
          }
          (f.three = f.three || []).push({ engine: "ogl" });
        }
      } catch (e) {
        note("ogl", e);
      }
      return render.apply(this, arguments);
    };
  }
  function scanEngines() {
    babylonScenes();
    for (const c of G.contexts) if (c._ctx) oglCheck(c._ctx);
  }

  // ---------------------------------------------------------------- WebGPU
  if (root.GPU && GPU.prototype.requestAdapter)
    patch(GPU.prototype, "requestAdapter", function (promise) {
      if (promise && promise.then)
        promise.then((adapter) => {
          try {
            if (adapter && adapter.info)
              G.webgpu.adapter = {
                vendor: adapter.info.vendor,
                architecture: adapter.info.architecture,
                device: adapter.info.device,
                description: adapter.info.description,
              };
          } catch (e) {}
        });
    });
  if (root.GPUDevice) {
    const gpuIds = new WeakMap();
    let gpuSeq = 0;
    const gid = (o, kind) => {
      let i = gpuIds.get(o);
      if (!i) {
        i = (cfg.prefix || "") + kind + ++gpuSeq;
        gpuIds.set(o, i);
      }
      return i;
    };
    patch(GPUDevice.prototype, "createShaderModule", function (module, [desc]) {
      G.webgpu.modules.push({ id: gid(module, "m"), label: desc && desc.label, code: desc && desc.code });
    });
    const pipeline = function (pl, [desc], kind) {
      const targets = desc && desc.fragment && desc.fragment.targets ? desc.fragment.targets.map((t) => t && { format: t.format, blend: t.blend }) : undefined;
      G.webgpu.pipelines.push({
        id: gid(pl, "pl"),
        kind,
        label: desc && desc.label,
        vertex: desc && desc.vertex && { module: gid(desc.vertex.module, "m"), entryPoint: desc.vertex.entryPoint },
        fragment: desc && desc.fragment && { module: gid(desc.fragment.module, "m"), entryPoint: desc.fragment.entryPoint, targets },
        compute: desc && desc.compute && { module: gid(desc.compute.module, "m"), entryPoint: desc.compute.entryPoint },
        primitive: desc && desc.primitive,
      });
    };
    patch(GPUDevice.prototype, "createRenderPipeline", function (pl, args) {
      pipeline(pl, args, "render");
    });
    patch(GPUDevice.prototype, "createComputePipeline", function (pl, args) {
      pipeline(pl, args, "compute");
    });
    patch(GPUDevice.prototype, "createBuffer", function (buf, [desc]) {
      G.webgpu.buffers.push({ id: gid(buf, "gb"), label: desc && desc.label, size: desc && desc.size, usage: desc && desc.usage });
    });
    if (root.GPUQueue)
      patch(GPUQueue.prototype, "writeBuffer", function (_, [buffer, offset, data, dataOffset, size]) {
        const f = frame();
        if (f.overflow || !data) return;
        const bytes = ArrayBuffer.isView(data) ? data.byteLength : data.byteLength;
        if (bytes > 1024) return; // uniforms, not geometry
        const view = ArrayBuffer.isView(data)
          ? new Float32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4))
          : new Float32Array(data, 0, Math.floor(data.byteLength / 4));
        const start = (dataOffset || 0) * (ArrayBuffer.isView(data) ? data.BYTES_PER_ELEMENT / 4 : 1 / 4);
        f.gpu[gid(buffer, "gb") + "@" + (offset || 0)] = Array.prototype.slice
          .call(view, start, Math.min(view.length, start + (size ? size / 4 : 64), start + 64))
          .map(tidy);
      });
    if (root.GPURenderPassEncoder)
      for (const name of ["draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect"])
        patch(GPURenderPassEncoder.prototype, name, function (_, a) {
          const f = frame();
          if (f.overflow) return;
          f.gpuDraws = (f.gpuDraws || 0) + 1;
          if (f.draws.length < CAP_DRAWS) f.draws.push({ gpu: name, n: a[0], i: a[1] });
        });
  }

  // ---------------------------------------------------------------- Canvas 2D
  if (cfg.canvas2d !== false && root.CanvasRenderingContext2D) {
    const proto = CanvasRenderingContext2D.prototype;
    const every = cfg.sampleCanvas2dEvery || 15;
    const fmt = (v) =>
      typeof v === "number"
        ? tidy(v)
        : typeof v === "string"
          ? v.slice(0, 60)
          : v && v.constructor
            ? "[" + v.constructor.name + (v.src ? " " + String(v.src).slice(-60) : "") + "]"
            : String(v);
    const log = (ctx, name, args) => {
      const rec = tagged.get(ctx);
      if (!rec) return;
      const f = frame();
      if (f.overflow) return;
      const per = ((f.canvas2d = f.canvas2d || {})[rec.id] = (f.canvas2d[rec.id] || { n: 0, calls: {} }));
      per.n++;
      per.calls[name] = (per.calls[name] || 0) + 1;
      if (f.i % every === 0 && per.n <= 2000) (per.log = per.log || []).push(name + "(" + Array.prototype.map.call(args, fmt).join(", ") + ")");
    };
    for (const name of Object.getOwnPropertyNames(proto)) {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc || name === "constructor") continue;
      if (typeof desc.value === "function" && !/^(get|is|measureText)/.test(name))
        patch(proto, name, function (_, args) {
          log(this, name, args);
        });
      else if (desc.set && /Style|global|line|font|shadow|filter|text|imageSmoothing/.test(name))
        Object.defineProperty(proto, name, {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get,
          set(v) {
            desc.set.call(this, v);
            try {
              log(this, name + "=", [v]);
            } catch (e) {}
          },
        });
    }
  }

  // ---------------------------------------------------------------- export
  G.export = function () {
    const out = {
      revision: T.revision,
      notes: G.notes,
      frames: G.frames.length,
      contexts: [],
      programs: [],
      textures: [],
      buffers: [],
      framebuffers: G.framebuffers,
      frameData: G.frames,
      three: null,
      webgpu: G.webgpu,
      engines: {},
      dumps: {},
      timeOrigin: performance.timeOrigin,
    };
    for (const c of G.contexts) {
      const o = {
        id: c.id,
        type: c.type,
        canvas: c.canvas,
        requested: c.requested,
        created: c.created,
        extensions: c.extensions ? Object.keys(c.extensions) : undefined,
      };
      try {
        const el = c._canvas;
        if (el) {
          o.size = [el.width, el.height];
          if (el.getBoundingClientRect) {
            const r = el.getBoundingClientRect();
            o.cssRect = [r.x, r.y, r.width, r.height].map((v) => Math.round(v));
            o.pixelRatio = r.width ? +(el.width / r.width).toFixed(3) : null;
          }
        }
        const gl = c._ctx;
        if (c.type === "webgl" || c.type === "webgl2") {
          o.attributes = gl.getContextAttributes();
          const dbg = gl.getExtension("WEBGL_debug_renderer_info");
          o.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
          o.version = gl.getParameter(gl.VERSION);
          o.contextLost = gl.isContextLost();
        }
      } catch (e) {
        note("export context", e);
      }
      out.contexts.push(o);
    }
    if (T.renderers.length || T.scenes.length) {
      out.three = {
        revision: T.revision || root.__THREE__ || null,
        renderers: [],
        scenes: [],
        loads: T.loads.length ? T.loads : undefined,
        mixers: T.mixers.length
          ? T.mixers.map((mixer) => ({
              root: mixer.getRoot && mixer.getRoot() && label(mixer.getRoot()),
              timeScale: mixer.timeScale,
              actions: (mixer._actions || []).map((action) => {
                const clip = action.getClip ? action.getClip() : action._clip;
                return {
                  clip: clip && clip.name,
                  duration: clip && clip.duration,
                  tracks:
                    clip &&
                    clip.tracks.slice(0, 60).map((track) => ({
                      name: track.name,
                      type: track.ValueTypeName,
                      keys: track.times.length,
                      times: Array.from(track.times.slice(0, 64)).map(tidy),
                      values: Array.from(track.values.slice(0, 256)).map(tidy),
                      interpolation: track.getInterpolation && track.getInterpolation(),
                    })),
                  running: action.isRunning && action.isRunning(),
                  time: tidy(action.time),
                  timeScale: action.timeScale,
                  weight: action.weight,
                  loop: action.loop,
                  repetitions: action.repetitions,
                  clampWhenFinished: action.clampWhenFinished,
                };
              }),
            }))
          : undefined,
      };
      for (const renderer of T.renderers) {
        const o = {};
        try {
          const clear = {
            r: 0,
            g: 0,
            b: 0,
            copy(c) {
              this.r = c.r;
              this.g = c.g;
              this.b = c.b;
              return this;
            },
          };
          if (renderer.getClearColor) renderer.getClearColor(clear);
          const size = renderer.getSize
            ? renderer.getSize({
                set(x, y) {
                  this.x = x;
                  this.y = y;
                  return this;
                },
              })
            : null;
          Object.assign(o, {
            kind: renderer.isWebGPURenderer ? "WebGPURenderer" : renderer.isWebGLRenderer ? "WebGLRenderer" : "renderer",
            canvas: labelElement(renderer.domElement),
            pixelRatio: renderer.getPixelRatio && renderer.getPixelRatio(),
            size: size && [size.x, size.y],
            toneMapping: renderer.toneMapping,
            toneMappingExposure: renderer.toneMappingExposure,
            outputColorSpace: renderer.outputColorSpace,
            outputEncoding: renderer.outputEncoding,
            clearColor: [clear.r, clear.g, clear.b].map(tidy),
            clearAlpha: renderer.getClearAlpha && renderer.getClearAlpha(),
            autoClear: renderer.autoClear,
            sortObjects: renderer.sortObjects,
            shadowMap: renderer.shadowMap && { enabled: renderer.shadowMap.enabled, type: renderer.shadowMap.type },
            info: renderer.info && {
              render: Object.assign({}, renderer.info.render),
              memory: Object.assign({}, renderer.info.memory),
            },
          });
          // give the GL programs a readable label from three's own program cache
          const programs = (renderer.info && renderer.info.programs) || [];
          for (const wp of programs) {
            const glProgram = wp && wp.program && tagged.get(wp.program);
            if (glProgram) glProgram.label = (wp.name ? wp.name + " " : "") + "(" + (wp.type || "material") + ")";
          }
          if (renderer.properties && renderer.properties.get)
            for (const scene of T.scenes)
              scene.traverse((o2) => {
                for (const m of o2.material ? (Array.isArray(o2.material) ? o2.material : [o2.material]) : []) {
                  const wp = renderer.properties.get(m).currentProgram;
                  const glProgram = wp && wp.program && tagged.get(wp.program);
                  if (glProgram) {
                    glProgram.three = glProgram.three || [];
                    const tagText = "three:s" + T.scenes.indexOf(scene) + "/mat:" + label(m) + " on " + label(o2);
                    if (!glProgram.three.includes(tagText)) glProgram.three.push(tagText);
                  }
                }
              });
        } catch (e) {
          note("export three renderer", e);
        }
        out.three.renderers.push(o);
      }
      T.scenes.forEach((scene, index) => {
        const o = { index, uuid: scene.uuid, name: scene.name, objects: 0, tree: [] };
        try {
          scene.traverse((node) => {
            o.objects++;
            if (o.tree.length >= 400) return;
            let depth = 0;
            for (let p = node.parent; p && p !== scene.parent; p = p.parent) depth++;
            const geo = node.geometry;
            const mats = node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : [];
            o.tree.push({
              depth,
              key: node === scene ? "scene" : label(node),
              type: node.type,
              name: node.name || undefined,
              visible: node.visible,
              renderOrder: node.renderOrder || undefined,
              position: node.position && node.position.toArray().map(tidy),
              rotation: node.rotation && [node.rotation.x, node.rotation.y, node.rotation.z].map(tidy),
              scale: node.scale && node.scale.toArray().map(tidy),
              geometry:
                geo && {
                  type: geo.type,
                  parameters: geo.parameters,
                  vertices: geo.attributes && geo.attributes.position ? geo.attributes.position.count : undefined,
                  attributes: geo.attributes ? Object.keys(geo.attributes) : undefined,
                  instances: node.count,
                },
              material: mats.length
                ? mats.map((m) => ({
                    key: label(m),
                    type: m.type,
                    name: m.name || undefined,
                    transparent: m.transparent,
                    blending: m.blending,
                    depthTest: m.depthTest,
                    depthWrite: m.depthWrite,
                    side: m.side,
                    opacity: m.opacity,
                    color: m.color && m.color.getHexString && "#" + m.color.getHexString(),
                    map: m.map ? (m.map.image && (m.map.image.currentSrc || m.map.image.src)) || m.map.name || "texture" : undefined,
                    uniforms: m.uniforms ? Object.keys(m.uniforms) : undefined,
                  }))
                : undefined,
              animations:
                node.animations && node.animations.length
                  ? node.animations.map((a) => ({ name: a.name, duration: a.duration, tracks: a.tracks.length }))
                  : undefined,
            });
          });
          if (cfg.sceneJson !== false) {
            const json = JSON.stringify(scene.toJSON());
            o.jsonBytes = json.length;
            if (json.length <= (cfg.maxSceneBytes || 40000000)) o._json = json;
          }
        } catch (e) {
          note("export three scene " + index, e);
        }
        out.three.scenes.push(o);
      });
    }
    for (const [kind, list] of Object.entries(G.engines))
      if (list.length) out.engines[kind] = list.map((e) => ({ version: e.version, kind: e.app ? "app" : e.renderer ? "renderer" : e.scene ? "scene" : "?" }));
    for (const p of G.programs) {
      const o = {
        id: p.id,
        label: p.label,
        three: p.three,
        ctx: p.ctx,
        links: p.links,
        deleted: p.deleted || undefined,
        draws: p.draws,
        primitives: Object.keys(p.primitives),
        maxCount: p.maxCount,
        maxInstances: p.maxInstances || undefined,
        state: p.state,
        layout: p.layout,
        vs: p.vsSource,
        fs: p.fsSource,
        uniforms: [],
        truncated: Object.keys(p.truncated).length ? p.truncated : undefined,
      };
      try {
        const gl = p._gl;
        if (!p.deleted && gl && !gl.isContextLost()) {
          const count = gl.getProgramParameter(p._program, gl.ACTIVE_UNIFORMS) || 0;
          for (let k = 0; k < count; k++) {
            const u = gl.getActiveUniform(p._program, k);
            if (!u) continue;
            const name = u.name.replace(/\[0\]$/, "");
            o.uniforms.push({ name, type: GL_TYPE[u.type] || u.type, size: u.size, value: p.values[name] });
          }
          const attribCount = gl.getProgramParameter(p._program, gl.ACTIVE_ATTRIBUTES) || 0;
          o.attributes = [];
          for (let k = 0; k < attribCount; k++) {
            const a = gl.getActiveAttrib(p._program, k);
            if (a) o.attributes.push({ name: a.name, type: GL_TYPE[a.type] || a.type, size: a.size });
          }
        }
      } catch (e) {
        note("export program", e);
      }
      if (!o.uniforms.length) o.uniforms = Object.keys(p.values).map((name) => ({ name, value: p.values[name] }));
      out.programs.push(o);
    }
    for (const t of G.textures) {
      const o = { id: t.id, w: t.w, h: t.h, uploads: t.uploads };
      if (t.src) {
        o.src = Object.assign({}, t.src);
        delete o.src._el;
        if (t.src._el && cfg.snapshotTextures !== false) {
          try {
            o.src.dataUrl = t.src._el.toDataURL ? t.src._el.toDataURL("image/png") : undefined;
          } catch (e) {}
        }
      }
      out.textures.push(o);
    }
    for (const b of G.buffers) {
      out.buffers.push({ id: b.id, target: b.target, usage: b.usage, type: b.type, bytes: b.bytes, uploads: b.uploads, subUploads: b.subUploads, sample: b.sample });
      if (b._dump) {
        const bytes = new Uint8Array(b._dump.buffer, b._dump.byteOffset, b._dump.byteLength);
        let text = "";
        for (let k = 0; k < bytes.length; k += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
        out.dumps[b.id] = { type: b.type, base64: btoa(text) };
      }
    }
    return out;
  };
});
