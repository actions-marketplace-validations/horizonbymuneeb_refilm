// refilm — the GPU trace: turning the raw in-page recording into files, and reading them back.
//
// The tracer records API calls; this module decides what they mean. Two things come out of it:
//
//   static facts  what the scene is made of — canvases and their settings, shaders, programs, attribute
//                 layouts, textures, buffers, framebuffers, render targets, draw order per frame.
//   channels      every value that changes during the capture, as one series per uniform component or per
//                 scene-graph property, each classified by what it does over time: a clock, a transition
//                 between two rests, a there-and-back, an oscillation, or a set of steps.
//
// The classification is what makes a trace cloneable: a "transition" is something you ease, a "clock" is
// something you drive from time, an "oscillation" is something you loop.
import { createHash } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA } from "../types.js";
import { ensureDir, exists, readJson, writeJson } from "../lib.js";
const round5 = (v) => +v.toPrecision(5);
/**
 * What does this series do over the capture? The answer decides how a clone drives it: by time (clock),
 * by an easing (transition), by a loop (oscillation), or by a keyframed step function (steps).
 */
export function classifySeries(times, values) {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    const base = { min: round5(min), max: round5(max) };
    if (!(range > 1e-7))
        return { ...base, firstChangeMs: null, lastChangeMs: null, kind: "constant" };
    const eps = range * 0.002;
    let first = -1;
    let last = -1;
    let ups = 0;
    let downs = 0;
    let turns = 0;
    let previous = 0;
    for (let i = 1; i < values.length; i++) {
        const delta = values[i] - values[i - 1];
        if (Math.abs(delta) <= eps)
            continue;
        if (first < 0)
            first = i - 1;
        last = i;
        const sign = Math.sign(delta);
        if (sign > 0)
            ups++;
        else
            downs++;
        if (previous && sign !== previous)
            turns++;
        previous = sign;
    }
    const firstChangeMs = Math.round(times[first + 1]);
    const lastChangeMs = Math.round(times[last]);
    const moving = ups + downs;
    const span = times[times.length - 1] - times[0];
    if (turns === 0) {
        // monotonic: a clock if it sweeps the whole capture at a steady rate, otherwise a one-way transition
        const n = values.length;
        const meanT = times.reduce((s, t) => s + t, 0) / n;
        const meanV = values.reduce((s, v) => s + v, 0) / n;
        let sxy = 0;
        let sxx = 0;
        let syy = 0;
        for (let i = 0; i < n; i++) {
            sxy += (times[i] - meanT) * (values[i] - meanV);
            sxx += (times[i] - meanT) ** 2;
            syy += (values[i] - meanV) ** 2;
        }
        const r2 = sxx && syy ? (sxy * sxy) / (sxx * syy) : 0;
        if (r2 > 0.995 && lastChangeMs - firstChangeMs > span * 0.8) {
            return { ...base, firstChangeMs, lastChangeMs, kind: "clock", perSecond: round5((sxy / sxx) * 1000) };
        }
        return { ...base, firstChangeMs, lastChangeMs, kind: "transition" };
    }
    if (turns >= 3) {
        // period from the mean distance between same-direction turning points
        const peaks = [];
        for (let i = 1; i < values.length - 1; i++) {
            if (values[i] > values[i - 1] + eps / 2 && values[i] >= values[i + 1])
                peaks.push(times[i]);
        }
        const periodMs = peaks.length >= 2 ? Math.round((peaks[peaks.length - 1] - peaks[0]) / (peaks.length - 1)) : undefined;
        return { ...base, firstChangeMs, lastChangeMs, kind: moving > values.length * 0.6 ? "oscillation" : "steps", periodMs };
    }
    return { ...base, firstChangeMs, lastChangeMs, kind: "there-and-back" };
}
// ------------------------------------------------------------------ naming
const slug = (s) => s.replace(/\(([^)]*)\)/g, "$1").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
const component = (size, k) => (size === 1 ? "" : size <= 4 ? "." + "xyzw"[k] : `[${k}]`);
/** Writes gl/, three/ and gl-track.json for a capture and returns the summary capture.json carries. */
export function writeGlArtifacts(out, trace, triggerAt, rate) {
    const dir = join(out, "gl");
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(out, "three"), { recursive: true, force: true });
    ensureDir(dir);
    /** Page time (ms) -> reference time (ms), 0 at the trigger. */
    const ref = (pageMs) => +((pageMs - triggerAt) * rate).toFixed(1);
    const programKey = new Map();
    for (const p of trace.programs)
        programKey.set(p.id, p.id + (p.label ? ":" + slug(p.label) : ""));
    // ---- shader sources, one file per program
    const shaderDir = ensureDir(join(dir, "shaders"));
    for (const p of trace.programs) {
        const base = programKey.get(p.id).replace(":", "-");
        p.files = {};
        if (p.vs) {
            writeFileSync(join(shaderDir, base + ".vert"), p.vs);
            p.files.vs = `gl/shaders/${base}.vert`;
        }
        if (p.fs) {
            writeFileSync(join(shaderDir, base + ".frag"), p.fs);
            p.files.fs = `gl/shaders/${base}.frag`;
        }
        delete p.vs;
        delete p.fs;
    }
    for (const module of trace.webgpu?.modules ?? []) {
        if (!module.code)
            continue;
        const file = `${module.id}${module.label ? "-" + slug(module.label) : ""}.wgsl`;
        writeFileSync(join(shaderDir, file), module.code);
        module.file = `gl/shaders/${file}`;
        delete module.code;
    }
    // ---- buffer dumps and canvas textures
    for (const [id, dump] of Object.entries(trace.dumps ?? {})) {
        const file = `${id}.${String(dump.type).replace(/Array$/, "")}.bin`;
        writeFileSync(join(ensureDir(join(dir, "buffers")), file), Buffer.from(dump.base64, "base64"));
        const buffer = trace.buffers.find((b) => b.id === id);
        if (buffer)
            buffer.file = `gl/buffers/${file}`;
    }
    delete trace.dumps;
    for (const texture of trace.textures) {
        const dataUrl = texture.src?.dataUrl;
        if (!dataUrl)
            continue;
        writeFileSync(join(ensureDir(join(dir, "textures")), `${texture.id}.png`), Buffer.from(dataUrl.split(",")[1], "base64"));
        texture.src.file = `gl/textures/${texture.id}.png`;
        delete texture.src.dataUrl;
    }
    // ---- three.js scenes in three's own JSON format (ObjectLoader.parse loads them back)
    if (trace.three) {
        for (const scene of trace.three.scenes) {
            if (!scene._json)
                continue;
            const file = join(ensureDir(join(out, "three")), `scene-${scene.index}.json`);
            writeFileSync(file, scene._json);
            scene.file = `three/scene-${scene.index}.json`;
            delete scene._json;
        }
    }
    // ---- channels
    const frames = trace.frameData;
    const raw = new Map();
    const meta = new Map();
    const push = (key, time, value) => {
        let series = raw.get(key);
        if (!series)
            raw.set(key, (series = { times: [], values: [] }));
        series.times.push(time);
        series.values.push(value);
    };
    // uniforms: per (program, n-th draw of it in the frame) the changed values, replayed into a value per frame
    const uniformState = new Map();
    const byOrdinal = new Map();
    for (const frame of frames) {
        const time = ref(frame.t);
        for (const [key, delta] of Object.entries(frame.uniforms ?? {})) {
            uniformState.set(key, { ...(uniformState.get(key) ?? {}), ...delta });
        }
        for (const [programId, drawCount] of Object.entries(frame.pc ?? {})) {
            for (let ordinal = 0; ordinal < drawCount; ordinal++) {
                const values = uniformState.get(`${programId}#${ordinal}`);
                if (!values)
                    continue;
                for (const [name, vector] of Object.entries(values)) {
                    if (vector.length > 16)
                        continue;
                    vector.forEach((value, k) => {
                        const id = `${programId}|${name}|${k}|${vector.length}`;
                        let ordinals = byOrdinal.get(id);
                        if (!ordinals)
                            byOrdinal.set(id, (ordinals = new Map()));
                        let series = ordinals.get(ordinal);
                        if (!series)
                            ordinals.set(ordinal, (series = { times: [], values: [] }));
                        series.times.push(time);
                        series.values.push(value);
                    });
                }
            }
        }
    }
    for (const [id, ordinals] of byOrdinal) {
        const [programId, name, k, size] = id.split("|");
        const list = [...ordinals.entries()].sort((a, b) => a[0] - b[0]);
        const first = list[0][1];
        const identical = list.every(([, s]) => s.values.length === first.values.length && s.values.every((v, i) => v === first.values[i]));
        for (const [ordinal, series] of identical ? list.slice(0, 1) : list) {
            const key = `${programKey.get(programId) ?? programId}${identical ? "" : "#" + ordinal}.${name}${component(+size, +k)}`;
            raw.set(key, series);
            meta.set(key, { source: "uniform", program: programId, uniform: name });
        }
    }
    // scene graphs (three.js, pixi, playcanvas, babylon, ogl): deltas of camera / object / material values
    const sceneState = {};
    for (const frame of frames) {
        if (!frame.scene || !frame.three)
            continue;
        Object.assign(sceneState, frame.scene);
        const time = ref(frame.t);
        for (const [key, value] of Object.entries(sceneState)) {
            push(key, time, value);
            if (!meta.has(key))
                meta.set(key, { source: "scene" });
        }
    }
    // WebGPU uniform buffer writes
    const gpuState = {};
    for (const frame of frames) {
        if (!frame.gpu || !Object.keys(frame.gpu).length)
            continue;
        Object.assign(gpuState, frame.gpu);
        const time = ref(frame.t);
        for (const [key, vector] of Object.entries(gpuState)) {
            vector.forEach((value, k) => {
                const channelKey = `gpu:${key}[${k}]`;
                push(channelKey, time, value);
                if (!meta.has(channelKey))
                    meta.set(channelKey, { source: "webgpu" });
            });
        }
    }
    const channels = {};
    const constants = {};
    for (const [key, series] of raw) {
        const classification = classifySeries(series.times, series.values);
        if (classification.kind === "constant") {
            if (meta.get(key)?.source !== "scene" || Object.keys(constants).length < 2000)
                constants[key] = series.values[0];
            continue;
        }
        channels[key] = { ...meta.get(key), ...classification };
    }
    // samples: one per frame that drew something, every channel carried forward between its draws
    const keys = Object.keys(channels);
    const cursor = new Map(keys.map((k) => [k, 0]));
    const samples = [];
    const times = [...new Set(keys.flatMap((k) => raw.get(k).times))].sort((a, b) => a - b);
    const current = {};
    for (const time of times) {
        for (const key of keys) {
            const series = raw.get(key);
            let i = cursor.get(key);
            while (i < series.times.length && series.times[i] <= time) {
                current[key] = series.values[i];
                i++;
            }
            cursor.set(key, i);
        }
        samples.push({ t: time, v: { ...current } });
    }
    const track = {
        schema: SCHEMA,
        kind: "gl-track",
        channels,
        samples,
    };
    writeJson(join(out, "gl-track.json"), track);
    // ---- passes: what one frame draws, in order, per canvas
    const drawn = frames.filter((f) => f.draws?.length);
    const passes = [];
    const canvasOf = new Map(trace.contexts.map((c) => [c.id, c.canvas]));
    const contextIds = [...new Set(drawn.flatMap((f) => f.draws.map((d) => d.c ?? "webgpu")))];
    for (const contextId of contextIds) {
        const representative = [...drawn].reverse().find((f) => f.draws.some((d) => (d.c ?? "webgpu") === contextId));
        if (!representative)
            continue;
        for (const draw of representative.draws.filter((d) => (d.c ?? "webgpu") === contextId)) {
            const framebuffer = draw.fb && trace.framebuffers.find((f) => f.id === draw.fb);
            const target = `${contextId} ${canvasOf.get(contextId) ?? ""} → ` +
                (draw.gpu ? "webgpu" : draw.fb ? `framebuffer ${draw.fb}${framebuffer?.color ? " → texture " + framebuffer.color : ""}` : "screen");
            let pass = passes[passes.length - 1];
            if (!pass || pass.target !== target)
                passes.push((pass = { target, draws: [] }));
            const label = draw.gpu
                ? draw.gpu
                : `${programKey.get(draw.p) ?? draw.p} ${draw.m} ${draw.n}${draw.i ? " ×" + draw.i + " instances" : ""}${draw.tx ? " samples " + draw.tx.filter(Boolean).join(",") : ""} [${draw.st}]`;
            const last = pass.draws[pass.draws.length - 1];
            if (last && last.label === label)
                last.times++;
            else
                pass.draws.push({ label, times: 1 });
        }
    }
    const drawCounts = drawn.map((f) => f.draws.length + (f.dropped || 0));
    const drawCallsPerFrame = drawCounts.length ? +(drawCounts.reduce((s, n) => s + n, 0) / drawCounts.length).toFixed(1) : 0;
    writeJson(join(dir, "draws.json"), {
        note: "per frame: every draw call (p program, m primitive, n vertices, i instances, fb target framebuffer, tx bound textures by unit, st state), clears, engine render calls",
        frames: frames.map((f) => ({
            t: ref(f.t),
            draws: f.draws,
            dropped: f.dropped || undefined,
            clears: f.clears?.length ? f.clears : undefined,
            three: f.three,
            canvas2d: f.canvas2d ? Object.fromEntries(Object.entries(f.canvas2d).map(([k, v]) => [k, { n: v.n, calls: v.calls }])) : undefined,
        })),
    });
    // canvas 2D call logs from the sampled frames
    const logs = {};
    for (const frame of frames)
        for (const [contextId, value] of Object.entries(frame.canvas2d ?? {}))
            if (value.log)
                (logs[contextId] = logs[contextId] ?? []).push(`--- frame t=${ref(frame.t)}ms (${value.n} calls)`, ...value.log);
    for (const [contextId, lines] of Object.entries(logs))
        writeFileSync(join(dir, `canvas2d-${contextId}.txt`), lines.join("\n") + "\n");
    // ---- gl.json
    const animatedBy = new Map();
    for (const [key, channel] of Object.entries(channels))
        if (channel.program)
            animatedBy.set(channel.program + "|" + channel.uniform, [...(animatedBy.get(channel.program + "|" + channel.uniform) ?? []), key]);
    for (const program of trace.programs) {
        program.key = programKey.get(program.id);
        program.drawsPerFrame = drawn.length ? +(program.draws / drawn.length).toFixed(2) : 0;
        for (const uniform of program.uniforms) {
            const animated = animatedBy.get(program.id + "|" + uniform.name);
            if (animated)
                uniform.animated = animated;
        }
    }
    const renderer = trace.contexts.find((c) => c.renderer)?.renderer ??
        (trace.webgpu?.adapter ? `WebGPU ${[trace.webgpu.adapter.vendor, trace.webgpu.adapter.architecture, trace.webgpu.adapter.description].filter(Boolean).join(" ")}` : null);
    writeJson(join(dir, "gl.json"), {
        note: "static side of the GPU scene; animated values are channels in ../gl-track.json; shader sources in shaders/",
        renderer,
        contexts: trace.contexts,
        three: trace.three,
        engines: trace.engines && Object.keys(trace.engines).length ? trace.engines : undefined,
        workers: trace.workers,
        frames: frames.length,
        drawCallsPerFrame,
        passes,
        programs: trace.programs,
        textures: trace.textures,
        buffers: trace.buffers,
        framebuffers: trace.framebuffers,
        webgpu: trace.webgpu && (trace.webgpu.modules.length || trace.webgpu.pipelines.length) ? trace.webgpu : undefined,
        canvas2d: Object.keys(logs).length ? Object.keys(logs).map((c) => `gl/canvas2d-${c}.txt`) : undefined,
        constants,
        notes: trace.notes?.length ? trace.notes : undefined,
    });
    const summary = summarizeTrace(out);
    writeFileSync(join(dir, "summary.md"), summary + "\n");
    return {
        contexts: trace.contexts.map((c) => `${c.id} ${c.type} ${c.canvas}`),
        programs: trace.programs.length,
        drawCallsPerFrame,
        animatedChannels: keys.length,
        three: trace.three?.revision ? String(trace.three.revision) : undefined,
    };
}
// ------------------------------------------------------------------ summary
export function summarizeTrace(dirIn) {
    const dir = dirIn;
    const gl = readJson(join(dir, "gl", "gl.json"));
    const track = exists(join(dir, "gl-track.json")) ? readJson(join(dir, "gl-track.json")) : { schema: SCHEMA, kind: "gl-track", channels: {}, samples: [] };
    const lines = [];
    lines.push(`# GPU trace: ${dir}`, "");
    lines.push(`renderer: ${gl.renderer ?? "?"} · ${gl.frames} frames traced · ${gl.drawCallsPerFrame} draw calls per frame`, "");
    lines.push("## Canvases");
    for (const c of gl.contexts) {
        const size = c.size ? c.size.join("×") : "?";
        const css = c.cssRect ? `, css ${c.cssRect[2]}×${c.cssRect[3]} at ${c.cssRect[0]},${c.cssRect[1]} (pixel ratio ${c.pixelRatio})` : "";
        const attrs = c.attributes
            ? `, antialias ${c.attributes.antialias}, alpha ${c.attributes.alpha}, premultipliedAlpha ${c.attributes.premultipliedAlpha}, preserveDrawingBuffer ${c.attributes.preserveDrawingBuffer}`
            : "";
        lines.push(`- ${c.id} ${c.type} on ${c.canvas}: ${size} px${css}${attrs}`);
    }
    if (gl.three) {
        lines.push("", `## three.js r${gl.three.revision ?? "?"}`);
        for (const r of gl.three.renderers) {
            lines.push(`- ${r.kind} on ${r.canvas}: pixelRatio ${r.pixelRatio}, size ${r.size?.join("×")}, outputColorSpace ${r.outputColorSpace ?? r.outputEncoding}, toneMapping ${r.toneMapping} (exposure ${r.toneMappingExposure}), clear ${JSON.stringify(r.clearColor)} α${r.clearAlpha}, autoClear ${r.autoClear}`);
        }
        for (const scene of gl.three.scenes) {
            lines.push(`- scene ${scene.index}${scene.name ? ` "${scene.name}"` : ""}: ${scene.objects} objects${scene.file ? `, full JSON in ${scene.file} (THREE.ObjectLoader)` : ""}`);
            for (const node of scene.tree.slice(0, 40)) {
                if (node.key === "scene")
                    continue;
                const geo = node.geometry ? ` ${node.geometry.type}${node.geometry.parameters ? JSON.stringify(node.geometry.parameters) : ""} ${node.geometry.vertices ?? "?"} verts` : "";
                const material = node.material
                    ? " · " +
                        node.material
                            .map((m) => `${m.type}${m.name ? ` "${m.name}"` : ""}${m.transparent ? " transparent" : ""}${m.uniforms ? ` uniforms[${m.uniforms.join(",")}]` : ""}`)
                            .join(", ")
                    : "";
                lines.push(`  ${"  ".repeat(node.depth)}- ${node.key} ${node.type}${geo}${material} pos ${JSON.stringify(node.position)} rot ${JSON.stringify(node.rotation)}${node.visible ? "" : " (hidden)"}`);
            }
            if (scene.tree.length > 40)
                lines.push(`  … ${scene.tree.length - 40} more in gl/gl.json`);
        }
        for (const mixer of gl.three.mixers ?? [])
            for (const action of mixer.actions)
                lines.push(`- AnimationMixer on ${mixer.root}: clip "${action.clip}" ${action.duration?.toFixed?.(3)} s, ${action.tracks?.length} tracks, ${action.running ? "running" : "stopped"}, timeScale ${action.timeScale}`);
        if (gl.three.loads?.length)
            lines.push(`- loaded through three.js loaders: ${gl.three.loads.map((x) => `${x.loader} ${x.url}`).join(", ")}`);
    }
    if (gl.engines && Object.keys(gl.engines).length)
        lines.push("", "## Other engines", ...Object.entries(gl.engines).map(([k, v]) => `- ${k}: ${v.map((e) => `${e.kind}${e.version ? " v" + e.version : ""}`).join(", ")}; scene values are \`${k}:…\` channels`));
    lines.push("", "## Programs (shaders in gl/shaders/)");
    for (const program of gl.programs) {
        if (!program.draws)
            continue;
        lines.push(`- **${program.key}**: ${program.drawsPerFrame}/frame, ${program.primitives.join("/")} up to ${program.maxCount} verts${program.maxInstances ? ` × ${program.maxInstances} instances` : ""}, ${program.state}${program.files?.fs ? ` (${program.files.vs}, ${program.files.fs})` : ""}`);
        if (program.three?.length)
            lines.push(`  - three.js: ${program.three.join("; ")}`);
        const animated = program.uniforms.filter((u) => u.animated).map((u) => u.name);
        const fixed = program.uniforms
            .filter((u) => !u.animated && u.value !== undefined && !/^(sampler|isampler|usampler)/.test(u.type ?? "") && (u.value?.length ?? 0) <= 4)
            .map((u) => `${u.name}=${u.value.length === 1 ? u.value[0] : "[" + u.value.join(",") + "]"}`);
        if (animated.length)
            lines.push(`  - animated: ${animated.join(", ")}`);
        if (fixed.length)
            lines.push(`  - fixed: ${fixed.slice(0, 24).join(", ")}${fixed.length > 24 ? " …" : ""}`);
        if (program.layout?.length)
            lines.push(`  - attributes: ${program.layout
                .map((a) => (a.constant ? `${a.name}(constant)` : `${a.name} ${a.size}×${a.type} buf ${a.buffer}${a.divisor ? " per-instance" : ""}`))
                .join(", ")}`);
    }
    const unused = gl.programs.filter((p) => !p.draws).length;
    if (unused)
        lines.push(`- (${unused} programs compiled but not drawn during the capture)`);
    if (gl.passes?.length) {
        lines.push("", "## One frame per canvas, in draw order (render target: draws)");
        for (const pass of gl.passes)
            lines.push(`- ${pass.target}: ${pass.draws.map((d) => d.label + (d.times > 1 ? ` ×${d.times}` : "")).join("; ")}`);
    }
    const textured = gl.textures.filter((t) => t.src && t.src.kind !== "empty" && t.src.kind !== "storage" && !(t.w === 1 && t.h === 1));
    if (textured.length) {
        lines.push("", "## Textures with content");
        for (const t of textured.slice(0, 30))
            lines.push(`- ${t.id} ${t.w}×${t.h} ${t.src.kind}${t.src.url ? " " + t.src.url : ""}${t.src.file ? " → " + t.src.file : ""}${t.uploads > 1 ? ` (${t.uploads} uploads: updated while running)` : ""}`);
    }
    if (gl.webgpu)
        lines.push("", "## WebGPU", `- ${gl.webgpu.modules.length} shader modules (WGSL in gl/shaders/), ${gl.webgpu.pipelines.length} pipelines`);
    if (gl.canvas2d)
        lines.push("", "## Canvas 2D", ...gl.canvas2d.map((f) => `- call log of sampled frames: ${f}`));
    const channelList = Object.entries(track.channels);
    if (channelList.length) {
        lines.push("", `## Animated channels (${channelList.length}; read one with: refilm gl channels <dir> --series KEY)`);
        const order = ["transition", "there-and-back", "oscillation", "steps", "clock"];
        const shown = channelList.sort((a, b) => order.indexOf(a[1].kind) - order.indexOf(b[1].kind) || (a[1].firstChangeMs ?? 0) - (b[1].firstChangeMs ?? 0));
        for (const [key, channel] of shown.slice(0, 60))
            lines.push(`- ${key}: ${channel.kind}${channel.kind === "clock" ? ` (+${channel.perSecond}/s)` : ""}${channel.periodMs ? ` period ~${channel.periodMs} ms` : ""}, ${channel.min} → ${channel.max}, changes ${channel.firstChangeMs}–${channel.lastChangeMs} ms`);
        if (shown.length > 60)
            lines.push(`- … ${shown.length - 60} more: refilm gl channels ${dir}`);
    }
    if (gl.notes?.length)
        lines.push("", "## Tracer notes", ...gl.notes.map((n) => `- ${n}`));
    return lines.join("\n");
}
/** Every channel of the reference against its counterpart in the clone. */
export function compareTraces(refDir, cloneDir, opts = {}) {
    const timingLimit = opts.timing ?? 80;
    const map = opts.map ?? {};
    const grep = opts.grep ?? null;
    const R = readJson(join(refDir, "gl", "gl.json"));
    const C = readJson(join(cloneDir, "gl", "gl.json"));
    const rt = readJson(join(refDir, "gl-track.json"));
    const ct = readJson(join(cloneDir, "gl-track.json"));
    // GlTrack keeps channels as unknown on purpose (the file is external); this is where they get their shape
    const refChannels = rt.channels;
    const cloneChannels = ct.channels;
    const lines = [`# GPU compare: ${refDir} vs ${cloneDir}`, ""];
    // canvases matched by element (tag, id, classes); probe canvases libraries create (300×150, not in the
    // page) are left out
    const gpuContexts = (g) => g.contexts.filter((c) => /webgl|webgpu/.test(c.type) && c.cssRect && c.cssRect[2] > 0);
    const format = (c) => c
        ? `${c.type} ${c.size?.join("×")} px (ratio ${c.pixelRatio}), antialias ${c.attributes?.antialias}, alpha ${c.attributes?.alpha}, premultipliedAlpha ${c.attributes?.premultipliedAlpha}`
        : "—";
    lines.push("## Canvases", "| canvas | reference | clone |", "|---|---|---|");
    const cloneContexts = gpuContexts(C);
    for (const r of gpuContexts(R)) {
        const c = cloneContexts.find((x) => x.canvas === r.canvas);
        lines.push(`| ${r.canvas} | ${format(r)} | ${format(c)}${c && format(c) !== format(r) ? " **differs**" : ""} |`);
    }
    for (const c of cloneContexts)
        if (!gpuContexts(R).some((r) => r.canvas === c.canvas))
            lines.push(`| ${c.canvas} | — | ${format(c)} |`);
    if (R.three || C.three) {
        const renderers = (g) => g.three
            ? g.three.renderers
                .map((r) => `${r.canvas}: r${g.three.revision} ${r.outputColorSpace ?? r.outputEncoding}, toneMapping ${r.toneMapping}, pixelRatio ${r.pixelRatio}, clear ${JSON.stringify(r.clearColor)} α${r.clearAlpha}`)
                .join("<br>")
            : "—";
        lines.push(`| three.js renderers | ${renderers(R)} | ${renderers(C)} |`);
    }
    // draw structure: programs grouped by what they draw (primitive, vertex count, instances, blend/depth state)
    const signature = (g) => {
        const counts = new Map();
        for (const p of g.programs.filter((p) => p.draws)) {
            const key = `${p.primitives.join("/")} ${p.maxCount}${p.maxInstances ? " ×" + p.maxInstances : ""} [${p.state}]`;
            counts.set(key, +((counts.get(key) ?? 0) + p.drawsPerFrame).toFixed(2));
        }
        return counts;
    };
    const refSignature = signature(R);
    const cloneSignature = signature(C);
    lines.push("", "## Draw structure (draw calls per traced frame, by primitive · vertices · state)", "", "| draws | reference | clone |", "|---|---|---|");
    for (const key of [...new Set([...refSignature.keys(), ...cloneSignature.keys()])].sort())
        lines.push(`| ${key} | ${refSignature.get(key) ?? "—"} | ${cloneSignature.get(key) ?? "—"}${!refSignature.has(key) || !cloneSignature.has(key) ? " **only in one**" : ""} |`);
    lines.push("", `draw calls per frame: ${R.drawCallsPerFrame} vs ${C.drawCallsPerFrame}. A different rate for the same draw usually means a different render cadence (every frame vs every other frame).`);
    // channels matched by uniform / property name (prefixes differ between builds), or by --map
    const tail = (key) => key
        .replace(/^(w\d+\.)?p\d+(:[\w-]+)?(#\d+)?\./, "")
        .replace(/^(\w+):s\d+\//, "$1:")
        .replace(/#\d+/g, "");
    const cloneIndex = new Map();
    for (const key of Object.keys(cloneChannels))
        cloneIndex.set(tail(key), [...(cloneIndex.get(tail(key)) ?? []), key]);
    const seriesOf = (track, key) => track.samples.filter((s) => s.v[key] !== undefined).map((s) => [s.t, s.v[key]]);
    const nearest = (series, time) => {
        let best = series[0];
        for (const point of series)
            if (Math.abs(point[0] - time) < Math.abs(best[0] - time))
                best = point;
        return best[1];
    };
    const rows = [];
    let failures = 0;
    // several clone channels can share a name (every Group has a rotation.x): take the one that moves most alike
    const likeness = (r, c) => (c.kind === r.kind ? 0 : 1000) +
        Math.abs((c.firstChangeMs ?? 0) - (r.firstChangeMs ?? 0)) +
        Math.abs((c.lastChangeMs ?? 0) - (r.lastChangeMs ?? 0)) +
        (1000 * (Math.abs(c.min - r.min) + Math.abs(c.max - r.max))) / Math.max(1e-9, Math.abs(r.max - r.min));
    const taken = new Set();
    for (const [refKey, refChannel] of Object.entries(refChannels)) {
        if (refChannel.kind === "clock" || (grep && !grep.test(refKey)))
            continue;
        const wanted = map[tail(refKey)] ?? tail(refKey);
        const cloneKey = (cloneIndex.get(wanted) ?? [])
            .filter((k) => !taken.has(k))
            .sort((x, y) => likeness(refChannel, cloneChannels[x]) - likeness(refChannel, cloneChannels[y]))[0];
        if (cloneKey)
            taken.add(cloneKey);
        if (!cloneKey) {
            rows.push(`| ${refKey} | ${refChannel.kind} ${refChannel.min}→${refChannel.max} ${refChannel.firstChangeMs}–${refChannel.lastChangeMs} ms | (no channel named ${wanted}) | | missing |`);
            failures++;
            continue;
        }
        const cloneChannel = cloneChannels[cloneKey];
        const startDelta = refChannel.firstChangeMs !== null && cloneChannel.firstChangeMs !== null ? cloneChannel.firstChangeMs - refChannel.firstChangeMs : NaN;
        const endDelta = refChannel.lastChangeMs !== null && cloneChannel.lastChangeMs !== null ? cloneChannel.lastChangeMs - refChannel.lastChangeMs : NaN;
        const span = Math.max(1e-9, refChannel.max - refChannel.min);
        const refSeries = seriesOf(rt, refKey);
        const cloneSeries = seriesOf(ct, cloneKey);
        const diffs = refSeries.map(([time, value]) => Math.abs(nearest(cloneSeries, time) - value) / span);
        const mean = diffs.reduce((s, x) => s + x, 0) / Math.max(1, diffs.length);
        const ok = Math.abs(startDelta) <= timingLimit && Math.abs(endDelta) <= timingLimit && mean <= 0.05 && cloneChannel.kind === refChannel.kind;
        if (!ok)
            failures++;
        rows.push(`| ${refKey} | ${refChannel.kind} ${refChannel.min}→${refChannel.max} ${refChannel.firstChangeMs}–${refChannel.lastChangeMs} ms | ${cloneKey}: ${cloneChannel.kind} ${cloneChannel.min}→${cloneChannel.max} ${cloneChannel.firstChangeMs}–${cloneChannel.lastChangeMs} ms | start ${startDelta >= 0 ? "+" : ""}${startDelta} ms, end ${endDelta >= 0 ? "+" : ""}${endDelta} ms, mean |Δ| ${(mean * 100).toFixed(1)} % of range | ${ok ? "pass" : "FAIL"} |`);
    }
    lines.push("", `## Animated channels (${rows.length} in the reference; uniform time "clock" channels are skipped)`, "", "| reference | | clone | timing and value error | result |", "|---|---|---|---|---|", ...rows);
    lines.push("", `pass: same kind, start and end within ${timingLimit} ms, mean value error ≤ 5 % of the reference range. ${failures} of ${rows.length} failing.`);
    return { markdown: lines.join("\n"), failures, rows: rows.length };
}
// ------------------------------------------------------------------ channels listing
export function readGlTrack(dir) {
    const file = join(dir, "gl-track.json");
    if (!exists(file)) {
        throw new Error(`no gl-track.json in ${dir}: capture with --gl first`);
    }
    return readJson(file);
}
export function seriesFor(track, key) {
    const all = Object.keys(track.channels);
    const exact = all.filter((k) => k === key);
    const matches = exact.length ? exact : all.filter((k) => k.endsWith("." + key) || k.endsWith(key));
    if (matches.length !== 1) {
        throw new Error(matches.length ? `ambiguous channel "${key}": ${matches.join(", ")}` : `no channel "${key}"`);
    }
    return track.samples.filter((s) => s.v[matches[0]] !== undefined).map((s) => [s.t, s.v[matches[0]]]);
}
/** Stable hash of a frame directory, used to prove two captures are byte-identical. */
export function hashTree(files, read) {
    const hash = createHash("sha256");
    for (const file of files)
        hash.update(file).update(read(file));
    return hash.digest("hex");
}
