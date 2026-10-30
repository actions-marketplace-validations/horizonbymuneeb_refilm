// refilm — the capture engine.
//
// One page, one browser, one pass. What comes out is everything needed to rebuild the motion: a video,
// numbered frames, an inspection dump, a per-frame track, the capture metadata and (with --gl) a GPU trace.
//
// Two clocks:
//   real     Playwright records the page; frames are cut out of that video with ffmpeg at --fps. Fast, but
//            frame k is only approximately t = k/fps, and a slow machine drops frames.
//   virtual  the page runs on a clock the capturer moves by hand (inpage/clock.js). Each frame is advanced
//            to exactly t = k/fps and screenshotted, so a slow render costs wall time, never accuracy, and
//            two captures of the same page produce identical frames.

import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response } from "playwright";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { ffmpeg, ensureDir, listFrames, pad, probeMedia, writeJson, writeText } from "../lib.js";
import { SCHEMA, VERSION } from "../types.js";
import type { CaptureMeta, CaptureOptions, Track, TrackElement, Trigger } from "../types.js";
import { outPaths } from "./options.js";
import { initScript, type ClockConfig, type GlConfig } from "./inpage.js";
import { CONTEXT_PROBE, trackerScript } from "./tracker.js";
import { INSPECT_SCRIPT } from "./inspect-script.js";
import { cropPngFile, deviceCrop, pngSize, type CropRect } from "./crop.js";
import { prepare, planActions, runTrigger, scrollTarget, settle, type Action } from "./triggers.js";
import { writeGlArtifacts, type RawTrace } from "./gl.js";

export interface CaptureProgress {
  phase: "launch" | "load" | "prepare" | "frames" | "encode" | "inspect" | "gl" | "write";
  detail: string;
}

export interface CaptureResult {
  meta: CaptureMeta;
  out: string;
  frames: number;
  trackSamples: number;
  inspect: any;
  /** The on-disk artifacts, relative to --out, in the order they were written. */
  artifacts: string[];
  warnings: string[];
}

export interface CaptureHooks {
  onProgress?: (p: CaptureProgress) => void;
  warn?: (message: string) => void;
}

const FRAME_FILE = /^\d{4}\.png$/;

// ------------------------------------------------------------------ helpers

function clearPngs(dir: string): void {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) if (FRAME_FILE.test(file)) unlinkSync(join(dir, file));
}

async function networkQuiet(page: Page, inflight: Map<Request, number>, waitMs: number, virtual: boolean): Promise<void> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const requests = [...inflight.values()].some((started) => Date.now() - started < 10000);
    const workers = virtual
      ? await page
          .evaluate(() => ((window as any).__filmClock?.busy?.() ?? 0) as number)
          .catch(() => 0)
      : 0;
    if (!requests && !workers) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The crop the selector/pad/clip options describe, measured now (the element may have moved). */
async function cropRect(page: Page, opts: CaptureOptions): Promise<CropRect | undefined> {
  if (opts.clip) return opts.clip;
  if (!opts.selector) return undefined;
  const box = await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, opts.selector);
  if (!box) return undefined;
  const pad = opts.pad;
  return {
    x: Math.max(0, Math.floor(box.x - pad)),
    y: Math.max(0, Math.floor(box.y - pad)),
    width: Math.ceil(Math.min(opts.viewport.width - box.x + pad, box.width + 2 * pad)),
    height: Math.ceil(Math.min(opts.viewport.height - box.y + pad, box.height + 2 * pad)),
  };
}

// ------------------------------------------------------------------ the capture

export async function capturePage(opts: CaptureOptions, hooks: CaptureHooks = {}): Promise<CaptureResult> {
  const warn = hooks.warn ?? (() => {});
  const progress = hooks.onProgress ?? (() => {});
  const paths = outPaths(opts.out);
  const virtual = opts.clock === "virtual";
  const warnings: string[] = [];
  const artifacts: string[] = [];

  ensureDir(opts.out);
  const launchArgs: string[] = [];
  if (opts.gpu === "hardware") {
    launchArgs.push("--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu");
    if (process.platform === "darwin") launchArgs.push("--use-angle=metal");
    else if (process.platform === "linux") launchArgs.push("--use-angle=vulkan", "--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan");
  }
  // wheel scrolling is animated on the compositor's real clock, which a virtual capture cannot wait for
  if (virtual) launchArgs.push("--disable-smooth-scrolling");

  progress({ phase: "launch", detail: `chromium (${opts.gpu} gl, ${opts.viewport.width}x${opts.viewport.height} @${opts.scale}x)` });
  const browser: Browser = await chromium.launch({ headless: !opts.headed, args: launchArgs });
  let context: BrowserContext | null = null;

  try {
    context = await browser.newContext({
      viewport: opts.viewport,
      deviceScaleFactor: opts.scale,
      colorScheme: opts.colorScheme,
      reducedMotion: opts.reducedMotion,
      recordVideo: opts.video && !virtual ? { dir: paths.video, size: opts.viewport } : undefined,
    });

    // order matters: the clock replaces the time APIs first, the GPU tracer wraps rAF on top of it, and
    // the tracker samples last so it sees the final rAF
    await context.addInitScript(CONTEXT_PROBE);
    if (virtual || opts.seed !== null) {
      const clock: ClockConfig = { virtual, seed: opts.seed, hz: opts.rafHz, holdAtStart: virtual };
      await context.addInitScript(initScript("clock.js", clock as unknown as Record<string, unknown>));
    }
    if (opts.gl) {
      const gl: GlConfig = { dumpBuffers: Math.round(opts.glBuffersMb * 1024 * 1024) };
      await context.addInitScript(initScript("gl-hooks.js", gl as unknown as Record<string, unknown>));
    }
    if (opts.track.length) await context.addInitScript(trackerScript(opts.track));

    const page = await context.newPage();
    // the video's own clock starts when the page does; the trigger offset is measured against this
    const pageCreatedAt = Date.now();

    // ---- workers: init scripts never reach them and page.on("worker") fires after their code ran. A second
    // CDP session auto-attaches with waitForDebuggerOnStart, evaluates the seed (and tracer) inside each new
    // worker, then lets it run. Playwright's session cannot address child sessions, hence the non-flat
    // Target.sendMessageToTarget transport. Workers started by workers are not reached.
    const workers: Array<{ sessionId: string; url: string; index: number }> = [];
    let workerEval: (sessionId: string, expression: string) => Promise<any> = async () => null;
    if (opts.seed !== null || opts.gl) {
      try {
        const cdp = await context.newCDPSession(page);
        let messageId = 0;
        const pending = new Map<number, (message: any) => void>();
        /** Sends one protocol message into a child target and resolves with its reply (or null on timeout). */
        const send = (sessionId: string, method: string, params: object = {}) =>
          new Promise<any>((resolve) => {
            const id = ++messageId;
            pending.set(id, resolve);
            cdp
              .send("Target.sendMessageToTarget" as any, { sessionId, message: JSON.stringify({ id, method, params }) } as any)
              .catch(() => {
                pending.delete(id);
                resolve(null);
              });
            setTimeout(() => {
              if (pending.delete(id)) resolve(null);
            }, 10000);
          });
        cdp.on("Target.receivedMessageFromTarget" as any, (event: any) => {
          try {
            const message = JSON.parse(event.message);
            const resolve = message.id && pending.get(message.id);
            if (resolve) {
              pending.delete(message.id);
              resolve(message);
            }
          } catch {
            // a worker can post a message that is not protocol JSON; ignore it
          }
        });
        cdp.on("Target.attachedToTarget" as any, async (event: any) => {
          const { sessionId, targetInfo, waitingForDebugger } = event;
          if (targetInfo.type === "worker") {
            const index = workers.length;
            workers.push({ sessionId, url: targetInfo.url, index });
            const parts: string[] = [];
            if (opts.seed !== null) {
              // a distinct but deterministic stream per worker, so two runs still match
              parts.push(initScript("clock.js", { virtual: false, seed: (opts.seed + 7919 * (index + 1)) >>> 0 }));
            }
            if (opts.gl) {
              parts.push(initScript("gl-hooks.js", { dumpBuffers: Math.round(opts.glBuffersMb * 1024 * 1024), prefix: `w${index}.` }));
            }
            await send(sessionId, "Runtime.evaluate", { expression: parts.join("\n") });
          }
          if (waitingForDebugger) await send(sessionId, "Runtime.runIfWaitingForDebugger");
        });
        await cdp.send("Target.setAutoAttach" as any, { autoAttach: true, waitForDebuggerOnStart: true, flatten: false } as any);
        workerEval = async (sessionId: string, expression: string) => {
          const reply = await send(sessionId, "Runtime.evaluate", { expression, returnByValue: true });
          return reply?.result?.result?.value ?? null;
        };
      } catch (err) {
        warn(`worker instrumentation unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (opts.playbackRate !== 1 && !virtual) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Animation.enable");
      await cdp.send("Animation.setPlaybackRate", { playbackRate: opts.playbackRate });
    }

    // ---- network bookkeeping: in-flight requests (the virtual clock waits for them) and assets to save
    const inflight = new Map<Request, number>();
    page.on("request", (request) => inflight.set(request, Date.now()));
    page.on("requestfinished", (request) => inflight.delete(request));
    page.on("requestfailed", (request) => inflight.delete(request));

    const assetJobs: Promise<void>[] = [];
    const assetIndex: Array<Record<string, unknown>> = [];
    const ASSET_RE =
      /\.(glb|gltf|bin|hdr|exr|ktx2?|basis|drc|splinecode|riv|lottie|usdz|fbx|obj|mtl|ply|vrm|splat|ksplat|spz|glsl|vert|frag|vs|fs|wgsl)(\?|#|$)/i;
    if (opts.assets) {
      rmSync(join(opts.out, "assets"), { recursive: true, force: true });
      const saveAsset = async (response: Response, kind: string) => {
        try {
          if (response.status() !== 200) return;
          const body = await response.body();
          const url = response.url();
          const name = (basename(new URL(url).pathname) || "index").replace(/[^\w.\-]+/g, "_").slice(-80);
          const hashed = createHash("sha1").update(url).digest("hex").slice(0, 6) + "-" + name;
          writeFileSync(join(ensureDir(join(opts.out, "assets", kind)), hashed), body);
          assetIndex.push({ kind, url, file: join("assets", kind, hashed), bytes: body.length, contentType: response.headers()["content-type"] });
        } catch {
          // bodies of redirects, aborted or evicted responses are not available
        }
      };
      page.on("response", (response) => {
        const url = response.url();
        if (!/^https?:/.test(url)) return;
        const contentType = response.headers()["content-type"] || "";
        if (ASSET_RE.test(url) || /^model\//.test(contentType)) {
          const shader = /\.(glsl|vert|frag|vs|fs|wgsl)(\?|#|$)/i.test(url);
          assetJobs.push(saveAsset(response, shader ? "shaders" : "models"));
        } else if (/^image\//.test(contentType)) {
          // a texture the page sampled is worth keeping; the GL trace tells us which URLs those were
          assetJobs.push(saveAsset(response, "images"));
        } else if (/javascript|ecmascript/.test(contentType) || /\.m?js(\?|#|$)/.test(url)) assetJobs.push(saveAsset(response, "scripts"));
        else if (/json/.test(contentType) && /lottie|anim|scene|spline|unicorn|project|rive/i.test(url)) assetJobs.push(saveAsset(response, "data"));
      });
    }

    // ---- navigate
    progress({ phase: "load", detail: opts.url });
    const trigger: Trigger = opts.trigger;
    // A load trigger starts at navigation, so the recording is cut from its beginning; every other trigger
    // needs the page settled first, hence `load` (wait for subresources) instead of `commit`.
    await page.goto(opts.url, { waitUntil: trigger === "load" ? "commit" : "load", timeout: 60000 });
    const navigationAt: number = await page.evaluate(() => performance.now() as number).catch(() => 0);

    let triggerAt = 0; // page-clock ms of the trigger; frame extraction and track time are relative to it
    let triggeredAtWall = pageCreatedAt; // wall-clock ms of the same moment, for cutting the video
    let frameCount = 0;
    let preRollMs = 0;

    if (!virtual) {
      // ---- real clock: let the page settle, fire the trigger, record
      if (trigger === "load") {
        triggerAt = navigationAt;
      } else {
        await page.waitForTimeout(opts.waitBefore);
        if (opts.preJs) await page.evaluate(opts.preJs);
        if (opts.selector && trigger !== "scroll") {
          const found = await page.$(opts.selector);
          if (!found) throw new Error(`selector not found: ${opts.selector}`);
          await found.scrollIntoViewIfNeeded();
          await page.waitForTimeout(300);
        } else if (trigger === "scroll" && opts.selector) {
          await page.evaluate((selector) => {
            const el = document.querySelector(selector);
            if (el) window.scrollTo(0, Math.max(0, window.scrollY + el.getBoundingClientRect().top - innerHeight - 20));
          }, opts.selector);
          await page.waitForTimeout(300);
        }
        if (opts.preHover) {
          const box = await page.locator(opts.preHover).first().boundingBox();
          if (box) {
            await page.mouse.move(box.x + box.width * opts.hoverAt.x, box.y + box.height * opts.hoverAt.y);
            await page.waitForTimeout(opts.preHoverMs);
          } else warn(`pre-hover target not visible: ${opts.preHover}`);
        }
        triggerAt = await page.evaluate(() => performance.now());
        triggeredAtWall = Date.now();
        await runTrigger(page, opts);
      }
      await page.waitForTimeout(opts.duration / opts.playbackRate);
      progress({ phase: "frames", detail: "cutting frames from the recording" });
    } else {
      // ---- virtual clock: step, screenshot, repeat
      progress({ phase: "load", detail: "virtual clock held at navigation" });
      await networkQuiet(page, inflight, opts.networkWait, true);

      preRollMs = trigger !== "load" ? opts.preRoll : 0;
      if (trigger !== "load") {
        progress({ phase: "prepare", detail: `settle ${opts.waitBefore} ms of virtual time` });
        await prepare(page, opts);
      }

      const start: number = await page.evaluate(() => (window as any).__filmClock.now() as number);
      const at0 = start + preRollMs;
      triggerAt = at0;
      const plan: Action[] = (await planActions(page, opts)).map((action) => ({ ...action, at: at0 + action.at })).sort((a, b) => a.at - b.at);

      const frameMs = 1000 / opts.fps;
      const total = Math.round((preRollMs + opts.duration) / frameMs) + 1;
      const rawDir = ensureDir(paths.raw);
      clearPngs(rawDir);

      let now = start;
      const advanceTo = async (time: number) => {
        if (time > now + 1e-6) now = await page.evaluate((ms) => (window as any).__filmClock.step(ms) as number, time - now);
      };

      progress({ phase: "frames", detail: `${total} frames at ${opts.fps} fps, virtual clock` });
      for (let k = 0; k < total; k++) {
        const frameTime = start + k * frameMs;
        while (plan.length && plan[0].at <= frameTime) {
          const action = plan.shift()!;
          await advanceTo(action.at);
          await action.run();
        }
        await advanceTo(frameTime);
        await networkQuiet(page, inflight, opts.networkWait, true);
        if (opts.video) {
          await page.screenshot({ path: join(rawDir, `${pad(k + 1)}.png`), animations: "allow", caret: "initial" });
        }
      }
      // actions still queued (a drag release after the window) still run, so the page ends where it should
      for (const action of plan) {
        await advanceTo(action.at);
        await action.run();
      }

      if (opts.video) {
        progress({ phase: "encode", detail: "cropping frames and encoding video.mp4" });
        const clip = await cropRect(page, opts);
        ensureDir(paths.frames);
        clearPngs(paths.frames);
        const first = readdirSync(rawDir).filter((f) => FRAME_FILE.test(f)).sort();
        const probe = first.length ? pngSize(join(rawDir, first[0])) : undefined;
        const device = clip && probe ? deviceCrop(clip, opts.scale, probe.width, probe.height) : undefined;
        for (const file of first) {
          const from = join(rawDir, file);
          const to = join(paths.frames, file);
          if (device) {
            writeFileSync(to, readFileSync(from));
            cropPngFile(to, device);
          } else renameSync(from, to);
        }
        rmSync(rawDir, { recursive: true, force: true });
        frameCount = first.length;
        try {
          ffmpeg(
            ["-y", "-framerate", String(opts.fps), "-i", join(paths.frames, "%04d.png"), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "18", paths.videoMp4],
            { quiet: true },
          );
          artifacts.push("video.mp4");
        } catch (err) {
          const message = `video.mp4 not written: ${String(err).split("\n")[0]}`;
          warnings.push(message);
          warn(message);
        }
        writeJson(paths.framesJson, {
          schema: SCHEMA,
          fps: opts.fps,
          count: total,
          playbackRate: 1,
          preRollMs,
          triggerFrame: Math.round((preRollMs / 1000) * opts.fps),
          clip: clip ?? null,
          viewport: opts.viewport,
          scale: opts.scale,
          clock: "virtual",
          seed: opts.seed,
          rafHz: opts.rafHz,
          note: "frame i is exactly the page state at t = i/fps seconds, with t=0 preRoll before the trigger (virtual clock)",
        });
        artifacts.push("frames/", "frames.json");
      }
    }

    // ---- crop rect, measured after the motion (use --clip when the element moves a lot)
    const clip = await cropRect(page, opts);

    // ---- track samples
    const trackSamples: any[] = opts.track.length
      ? await page.evaluate(() => {
          const store = (window as any).__filmTrack;
          if (!store) return [];
          store.running = false;
          return store.samples;
        })
      : [];

    // ---- inspection
    progress({ phase: "inspect", detail: "animations, keyframes, styles, fonts, libraries" });
    const inspect: any = await page.evaluate(`(${INSPECT_SCRIPT})(${JSON.stringify(opts.selector ?? null)})`);

    // ---- GPU trace
    let glTrace: any = null;
    if (opts.gl) {
      progress({ phase: "gl", detail: "collecting the GPU trace" });
      glTrace = await page.evaluate(() => ((window as any).__filmGl ? (window as any).__filmGl.export() : null));
      if (glTrace && workers.length) {
        // worker traces join the page's; their frame times move onto the page clock through the clock history
        const history: Array<[number, number]> = virtual ? await page.evaluate(() => (window as any).__filmClock.history() as Array<[number, number]>) : [];
        const toPageTime = (workerTime: number, workerOrigin: number) => {
          const real = workerTime + workerOrigin - glTrace.timeOrigin;
          if (!virtual) return real;
          let mapped = history.length ? history[0][1] : real;
          for (const [realTime, virtualTime] of history) {
            if (realTime > real) break;
            mapped = virtualTime;
          }
          return mapped;
        };
        glTrace.workers = [];
        for (const worker of workers) {
          const json = await workerEval(worker.sessionId, "self.__filmGl ? JSON.stringify(self.__filmGl.export()) : null");
          if (!json) {
            glTrace.workers.push({ url: worker.url, traced: false });
            continue;
          }
          const data = JSON.parse(json);
          glTrace.workers.push({ url: worker.url, traced: true, contexts: data.contexts.length, programs: data.programs.length });
          for (const key of ["contexts", "programs", "textures", "buffers", "framebuffers"]) glTrace[key].push(...(data[key] ?? []));
          for (const frame of data.frameData) frame.t = toPageTime(frame.t, data.timeOrigin);
          glTrace.frameData = [...glTrace.frameData, ...data.frameData].sort((a: any, b: any) => a.t - b.t);
          Object.assign(glTrace.dumps, data.dumps);
          glTrace.webgpu.modules.push(...data.webgpu.modules);
          glTrace.webgpu.pipelines.push(...data.webgpu.pipelines);
          glTrace.notes.push(...data.notes.map((n: string) => `worker ${worker.index}: ${n}`));
        }
      }
    }

    // ---- renderer string (a throwaway context, so the page's own canvases are untouched)
    const renderer: string | null = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const gl = (canvas.getContext("webgl2") || canvas.getContext("webgl")) as WebGLRenderingContext | null;
      if (!gl) return null;
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      const name = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return name;
    });

    await page.screenshot({ path: paths.finalPng, clip: clip && clip.width > 0 && clip.height > 0 ? clip : undefined }).catch(() => {});

    if (opts.assets) {
      await Promise.all(assetJobs);
      writeJson(paths.assetsJson, assetIndex.sort((a, b) => String(a.file).localeCompare(String(b.file))));
      artifacts.push("assets.json");
    }

    await context.close();
    context = null;

    // ---- real clock: video -> frames
    if (!virtual && opts.video) {
      const videoDir = paths.video;
      const recorded = existsSync(videoDir)
        ? readdirSync(videoDir)
            .filter((f) => f.endsWith(".webm"))
            .map((f) => join(videoDir, f))
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
        : undefined;
      if (!recorded) {
        warnings.push("no video recorded; frames were not written");
        warn("no video recorded; frames were not written");
      } else {
        progress({ phase: "frames", detail: "cutting frames out of video.webm" });
        renameSync(recorded, paths.videoWebm);
        artifacts.push("video.webm");
        ensureDir(paths.frames);
        clearPngs(paths.frames);
        // the video starts at page creation; the trigger offset is wall time from there, minus the pre-roll
        const triggerOffset = Math.max(0, (triggeredAtWall - pageCreatedAt) / 1000 - opts.preRoll / 1000);
        const videoFps = opts.fps * opts.playbackRate;
        const filters = [`fps=${videoFps}`];
        if (clip) {
          filters.push(
            `crop=${Math.round(clip.width * opts.scale)}:${Math.round(clip.height * opts.scale)}:${Math.round(clip.x * opts.scale)}:${Math.round(clip.y * opts.scale)}`,
          );
        }
        try {
          ffmpeg(
            ["-y", "-ss", triggerOffset.toFixed(3), "-i", paths.videoWebm, "-t", ((opts.duration + opts.preRoll) / opts.playbackRate / 1000).toFixed(3), "-vf", filters.join(","), join(paths.frames, "%04d.png")],
            { quiet: true },
          );
        } catch (err) {
          warnings.push(`frames not extracted: ${String(err).split("\n")[0]}`);
        }
        frameCount = listFrames(paths.frames).length;
        writeJson(paths.framesJson, {
          schema: SCHEMA,
          fps: opts.fps,
          count: frameCount,
          playbackRate: opts.playbackRate,
          preRollMs: opts.preRoll,
          triggerFrame: Math.round((opts.preRoll / 1000) * opts.fps),
          clip: clip ?? null,
          viewport: opts.viewport,
          scale: opts.scale,
          clock: "real",
          seed: opts.seed,
          note: "frame i is at t = i/fps seconds of reference time, with t=0 preRoll before the trigger",
        });
        artifacts.push("frames/", "frames.json");
      }
    }

    // ---- normalise track time: t = 0 at the trigger
    const zero = triggerAt ?? (trackSamples.length ? trackSamples[0].t : 0);
    const track: Track = {
      schema: SCHEMA,
      kind: "track",
      selectors: opts.track,
      playbackRate: opts.playbackRate,
      fps: opts.fps,
      note: "t in ms of reference time, 0 = trigger; negative samples are before it",
      samples: trackSamples.map((sample: any) => ({
        t: +((sample.t - zero) * opts.playbackRate).toFixed(1),
        scrollY: sample.scrollY,
        els: Object.fromEntries(
          Object.entries<any>(sample.els ?? {}).map(([selector, value]) => [
            selector,
            value === null ? (null as unknown as TrackElement) : (value as TrackElement),
          ]),
        ),
      })),
    };
    if (opts.track.length) {
      writeJson(paths.track, track);
      artifacts.push("track.json");
    }
    writeJson(paths.inspect, inspect);
    artifacts.push("inspect.json");

    // ---- GPU artifacts
    let glSummary: CaptureMeta["gl"];
    if (glTrace) {
      const rate = virtual ? 1 : opts.playbackRate;
      glSummary = writeGlArtifacts(opts.out, glTrace as RawTrace, zero, rate);
      artifacts.push("gl/", "gl-track.json");
    }

    // ---- capture.json
    progress({ phase: "write", detail: "capture.json" });
    const meta: CaptureMeta = {
      schema: SCHEMA,
      version: VERSION,
      kind: "capture",
      url: opts.url,
      title: String(inspect?.title ?? ""),
      createdAt: new Date().toISOString(),
      viewport: opts.viewport,
      scale: opts.scale,
      fps: opts.fps,
      frameCount,
      durationMs: opts.duration,
      preRollMs,
      trigger: opts.trigger,
      triggerFrame: Math.round((preRollMs / 1000) * opts.fps),
      clock: opts.clock,
      seed: opts.seed,
      rafHz: opts.rafHz,
      gpu: opts.gpu,
      rate: opts.playbackRate,
      selector: opts.selector,
      clip: clip ? { x: clip.x, y: clip.y, width: clip.width, height: clip.height } : undefined,
      trackSelectors: opts.track,
      trackSamples: track.samples.length,
      renderer: renderer ?? undefined,
      libs: inspect?.libs ?? [],
      fonts: (inspect?.fonts ?? []).map((f: any) => ({ family: f.family, weight: f.weight, style: f.style, status: f.status })),
      counts: {
        animations: inspect?.animations?.length ?? 0,
        keyframes: inspect?.keyframes?.length ?? 0,
        canvases: inspect?.canvases?.length ?? 0,
        nodes: inspect?.nodes?.length ?? 0,
      },
      gl: glSummary,
    };
    writeJson(paths.meta, meta);
    artifacts.push("capture.json");

    return { meta, out: opts.out, frames: frameCount, trackSamples: track.samples.length, inspect, artifacts, warnings };
  } finally {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
