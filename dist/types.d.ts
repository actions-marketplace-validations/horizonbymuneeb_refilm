export declare const SCHEMA = 1;
export interface Viewport {
    width: number;
    height: number;
}
export type Trigger = "load" | "scroll" | "hover" | "leave" | "move" | "drag" | "click" | "none";
export type Clock = "real" | "virtual";
export type GpuMode = "software" | "hardware";
export interface CaptureOptions {
    url: string;
    out: string;
    viewport: Viewport;
    scale: number;
    fps: number;
    duration: number;
    preRoll: number;
    waitBefore: number;
    trigger: Trigger;
    selector?: string;
    target?: string;
    clip?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    pad: number;
    track: string[];
    clock: Clock;
    seed: number | null;
    rafHz: number;
    networkWait: number;
    gl: boolean;
    glBuffersMb: number;
    gpu: GpuMode;
    assets: boolean;
    video: boolean;
    playbackRate: number;
    colorScheme?: "light" | "dark";
    reducedMotion: "no-preference" | "reduce";
    headed: boolean;
    preJs?: string;
    scrollTo?: string;
    scrollMs: number;
    scrollSteps: number;
    hoverAt: {
        x: number;
        y: number;
    };
    preHover?: string;
    preHoverMs: number;
    leaveTo?: {
        x: number;
        y: number;
    };
    path: Array<{
        x: number;
        y: number;
    }>;
    pathMs: number;
}
/** capture.json — written next to frames/ and read back by compare/verify. */
export interface CaptureMeta {
    schema: number;
    version: string;
    kind: "capture";
    url: string;
    title: string;
    createdAt: string;
    viewport: Viewport;
    scale: number;
    fps: number;
    frameCount: number;
    durationMs: number;
    preRollMs: number;
    trigger: Trigger;
    triggerFrame: number;
    clock: Clock;
    seed: number | null;
    rafHz: number;
    gpu: GpuMode;
    rate: number;
    selector?: string;
    clip?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    trackSelectors: string[];
    trackSamples: number;
    renderer?: string;
    libs: string[];
    fonts: Array<{
        family: string;
        weight?: string;
        style?: string;
        status?: string;
    }>;
    counts: {
        animations: number;
        keyframes: number;
        canvases: number;
        nodes: number;
    };
    gl?: GlSummary;
}
export interface GlSummary {
    contexts: string[];
    programs: number;
    drawCallsPerFrame: number;
    animatedChannels: number;
    three?: string;
}
export interface TrackElement {
    x: number;
    y: number;
    w: number;
    h: number;
    opacity: number;
    transform: string;
}
export interface TrackSample {
    t: number;
    scrollY: number;
    els: Record<string, TrackElement>;
}
/** track.json — one sample per animation frame. */
export interface Track {
    schema: number;
    kind: "track";
    selectors: string[];
    playbackRate: number;
    fps: number;
    note: string;
    samples: TrackSample[];
}
/** gl-track.json — one sample per rendered frame, keyed channels. */
export interface GlTrack {
    schema: number;
    kind: "gl-track";
    channels: Record<string, unknown>;
    samples: Array<{
        t: number;
        v: Record<string, number>;
    }>;
}
export type Fidelity = "motion" | "pixel" | "mixed";
export type EasingFamily = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "spring" | "steps" | "unknown";
export interface SpecRow {
    id: string;
    element: string;
    property: string;
    from: number | string;
    to: number | string;
    startMs: number | null;
    durationMs: number | null;
    easing: string | null;
    easingFamily: EasingFamily;
    staggerMs: number | null;
    overshoot: number | null;
    source: "declared" | "track" | "gl-track" | "frames" | "unknown";
    /** null means the value could not be measured; a spec row with nulls is not finished. */
    confidence: "high" | "medium" | "low";
}
export interface Spec {
    schema: number;
    kind: "spec";
    name: string;
    target: string;
    destination?: string;
    fidelity: Fidelity;
    viewport: Viewport;
    fps: number;
    trigger: Trigger;
    totalMs: number;
    rows: SpecRow[];
    staticFacts: Record<string, string | number>;
    additions: string[];
    unresolved: string[];
}
export interface FrameDetail {
    index: number;
    t: number;
    mismatch: number;
    diffPixels: number;
}
export interface MotionWindow {
    first: number;
    last: number;
    peak: number;
    startS: number;
    endS: number;
    durationS: number;
}
export interface CompareReport {
    schema: number;
    kind: "compare";
    fps: number;
    size: [number, number];
    offset: number;
    threshold: number;
    motionThreshold: number;
    pixelThreshold: number;
    setupWarnings: string[];
    frames: number;
    compared: number;
    meanMismatch: number;
    maxMismatch: number;
    blurredMeanMismatch?: number;
    worstFrames: FrameDetail[];
    motion: {
        ref: MotionWindow;
        clone: MotionWindow;
    };
    timingError: {
        start: number;
        end: number;
        duration: number;
        peak: number;
    };
    activity: Array<{
        t: number;
        ref: number;
        clone: number;
    }>;
    pass: boolean;
    failures: string[];
    frameDetails: FrameDetail[];
}
export interface VerifyCheck {
    id: string;
    label: string;
    status: "pass" | "fail" | "skip";
    measured: number | string | null;
    limit: number | string | null;
    detail?: string;
}
export interface VerifyResult {
    schema: number;
    kind: "verify";
    fidelity: Fidelity;
    pass: boolean;
    checks: VerifyCheck[];
    counts: {
        pass: number;
        fail: number;
        skip: number;
    };
    artifacts: Record<string, string>;
}
export interface DoctorCheck {
    id: string;
    status: "ok" | "warn" | "fail";
    detail: string;
    fix?: string;
}
export interface DoctorReport {
    schema: number;
    kind: "doctor";
    ok: boolean;
    checks: DoctorCheck[];
    environment: {
        node: string;
        platform: string;
        arch: string;
        ffmpeg: string | null;
        chromium: string | null;
        version: string;
    };
}
