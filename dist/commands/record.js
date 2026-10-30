// refilm record — film a page deterministically and write everything needed to clone its motion.
//
// The capture engine lives in src/engine/; this file is the command surface: help text, argv validation,
// progress output and the --json envelope.
import { EXIT, RefilmError, envError, parseArgs, reporter } from "../lib.js";
import { capturePage } from "../engine/capture.js";
import { parseCaptureOptions, TRIGGERS } from "../engine/options.js";
export const help = `
refilm record — film a page and dump everything needed to rebuild its motion.

  refilm record --url <url|file.html> --out <dir> [options]

Window
  --viewport WxH        viewport, default 1440x900 (use the same for reference and clone)
  --scale N             deviceScaleFactor, default 1
  --color-scheme S      light | dark
  --reduced-motion S    no-preference (default) | reduce

What to look at
  --selector CSS        element to scroll into view and crop frames to (default: whole viewport)
  --pad PX              extra margin around the selector crop, default 0
  --clip x,y,w,h        explicit crop in CSS px (overrides the --selector crop)

How to start the motion
  --trigger T           ${TRIGGERS.join(" | ")} (default: load)
                        load   the window starts at navigation (page-load animations)
                        scroll wheel the page in steps so scroll-reveal / scroll-linked motion plays
                        hover / click   act on --target (default: --selector)
                        leave  move the pointer off whatever it is on (hover-out); pair with --pre-hover
                        move   glide the pointer through --path inside --target (pointer-follow effects)
                        drag   like move with the button held: down at the first point, glide, up at the last
                        none   just record (loops, marquees, idle animations)
  --target CSS          element to hover/click/move over
  --hover-at FX,FY      where to put the pointer on --target, as fractions of its box (default 0.5,0.5)
  --pre-hover CSS       hover this element before the trigger (uses --hover-at) and wait --pre-hover-ms
  --pre-hover-ms MS     default 1500
  --leave-to X,Y        viewport point the pointer moves to for --trigger leave, default <width/2>,8
  --path "FX,FY;…"      move/drag: fractional points inside --target, visited in order
  --path-ms MS          move/drag: time spent between two points, default 400
  --scroll-to PX|CSS    scroll position (or element) to reach during a scroll trigger
  --scroll-ms MS        how long the stepped scroll takes, default 600
  --scroll-steps N      wheel steps, default 12
  --wait-before MS      settle time after load before the trigger, default 800
  --pre-js FILE|CODE    JS to run after load, before the trigger (dismiss banners, open a menu…)
  --duration MS         how long to record after the trigger, default 3000
  --pre-roll MS         frames to keep before the trigger, default 200

Output
  --fps N               extracted frame rate, default 25
  --playback-rate R     slow CSS/WAAPI animations with CDP (0.25 = 4x slower). JS-driven motion is unaffected.
  --track "CSS, CSS"    elements sampled every animation frame → track.json (default: --selector, if any)
  --no-video            skip the video and frames (inspection + track only)
  --headed              show the browser (needs a display)
  --json                machine-readable summary on stdout

Canvas, WebGL and 3D
  --clock real|virtual  real (default) records the page and cuts frames out of the video. virtual runs the
                        page on a clock the capturer advances by hand: performance.now, Date, timers, rAF,
                        CSS/WAAPI animation time and event timestamps all follow it, so frame k is exactly
                        t = k/fps whatever the machine does, and two captures are identical.
  --seed N              seed Math.random (default 1 with --clock virtual). Same seed, same particles.
  --raf-hz N            virtual clock frame rate seen by the page, default 60
  --network-wait MS     virtual clock: wait up to MS for in-flight work before each frame, default 3000
  --gl                  trace WebGL/WebGL2/WebGPU/canvas 2D and three.js/Pixi/PlayCanvas/Babylon/OGL:
                        shaders, programs, draw calls, textures, buffers, uniforms and scene graph per frame
                        → gl/, gl-track.json
  --gl-buffers MB       with --gl, also dump vertex/index buffer contents (first upload) up to MB, default off
  --gpu software|hardware
                        software (default, SwiftShader: identical everywhere) | hardware (real GPU, fast,
                        and WebGPU enabled). Record reference and clone with the same mode.
  --assets              save the page's 3D models, textures, shader files, Lottie/Rive files and scripts
                        → assets/ + assets.json

Writes to <out>/: video.webm (video.mp4 with --clock virtual), frames/NNNN.png, frames.json, inspect.json,
track.json, capture.json, and with --gl: gl/gl.json, gl/shaders/, gl/draws.json, gl/summary.md, gl-track.json,
three/. --no-video keeps inspect.json, track.json and capture.json only.

Examples
  refilm record --url https://example.com --out .refilm/ref --selector .hero --trigger load --duration 2000
  refilm record --url clone.html --out .refilm/clone --selector .hero --trigger load --duration 2000
  refilm record --url scene.html --out .refilm/ref --clock virtual --gl --duration 1500 --fps 30
`;
function humanSummary(meta, out, trackSamples, frames) {
    const lines = [];
    const pad = (label) => label.padEnd(12);
    lines.push(`${pad("capture")}${out}`);
    lines.push(`${pad("page")}${meta.title || "(untitled)"} — ${meta.url}`);
    lines.push(`${pad("viewport")}${meta.viewport.width}x${meta.viewport.height} @${meta.scale}x · ${meta.fps} fps · ${meta.clock} clock`);
    lines.push(`${pad("frames")}${frames}${meta.clip ? ` · cropped ${meta.clip.width}x${meta.clip.height} at ${meta.clip.x},${meta.clip.y}` : ""}`);
    lines.push(`${pad("trigger")}${meta.trigger} · trigger frame ${meta.triggerFrame} · ${meta.durationMs} ms`);
    lines.push(`${pad("motion")}${meta.counts.animations} animations · ${meta.counts.keyframes} keyframes · ${meta.counts.canvases} canvases · ${meta.counts.nodes} nodes`);
    lines.push(`${pad("track")}${trackSamples} samples${meta.trackSelectors.length ? ` of ${meta.trackSelectors.join(", ")}` : ""}`);
    if (meta.libs.length)
        lines.push(`${pad("libraries")}${meta.libs.join(", ")}`);
    if (meta.fonts.length)
        lines.push(`${pad("fonts")}${meta.fonts.slice(0, 6).map((f) => f.family).join(", ")}${meta.fonts.length > 6 ? ` +${meta.fonts.length - 6}` : ""}`);
    if (meta.renderer)
        lines.push(`${pad("renderer")}${meta.renderer}`);
    if (meta.gl) {
        lines.push(`${pad("gpu")}${meta.gl.programs} programs · ${meta.gl.drawCallsPerFrame} draws/frame · ${meta.gl.animatedChannels} animated channels${meta.gl.three ? ` · three.js r${meta.gl.three}` : ""}`);
    }
    return lines;
}
export async function run(argv, ctx) {
    const out = reporter("record", { json: ctx.json });
    const a = parseArgs(argv);
    if (a.help) {
        console.log(help.trim());
        return EXIT.OK;
    }
    if (a.version) {
        console.log(String(a.version === true ? "" : a.version));
        return EXIT.OK;
    }
    const { options } = parseCaptureOptions(argv);
    if (options.clock === "virtual" && options.playbackRate !== 1) {
        out.warn("--playback-rate is ignored with --clock virtual: every frame is exact, raise --fps instead");
    }
    const started = Date.now();
    const onProgress = (p) => out.info(`[${p.phase}] ${p.detail}`);
    let result;
    try {
        result = await capturePage(options, { onProgress, warn: (message) => out.warn(message) });
    }
    catch (err) {
        if (err instanceof RefilmError)
            throw err;
        const message = err instanceof Error ? err.message : String(err);
        if (/Executable doesn't exist|browserType\.launch|Failed to launch/i.test(message)) {
            throw envError(`could not launch chromium: ${message.split("\n")[0]}`, "run: npx playwright install chromium — refilm never downloads a browser on its own");
        }
        if (/ffmpeg/i.test(message))
            throw envError(message.split("\n")[0], "install ffmpeg or set REFILM_FFMPEG");
        throw new RefilmError("CAPTURE_FAILED", message, EXIT.INTERNAL);
    }
    const { meta } = result;
    out.say(humanSummary(meta, result.out, result.trackSamples, result.frames).join("\n"));
    out.emit("record", {
        out: result.out,
        url: meta.url,
        title: meta.title,
        viewport: meta.viewport,
        scale: meta.scale,
        fps: meta.fps,
        clock: meta.clock,
        seed: meta.seed,
        rafHz: meta.rafHz,
        gpu: meta.gpu,
        trigger: meta.trigger,
        triggerFrame: meta.triggerFrame,
        durationMs: meta.durationMs,
        preRollMs: meta.preRollMs,
        frames: result.frames,
        clip: meta.clip ?? null,
        selector: meta.selector ?? null,
        trackSelectors: meta.trackSelectors,
        trackSamples: result.trackSamples,
        libs: meta.libs,
        fonts: meta.fonts,
        counts: meta.counts,
        renderer: meta.renderer ?? null,
        gl: meta.gl ?? null,
        artifacts: result.artifacts,
        elapsedMs: Date.now() - started,
    });
    return EXIT.OK;
}
