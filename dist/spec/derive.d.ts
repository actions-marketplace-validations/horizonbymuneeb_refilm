import type { Fidelity, Spec, Trigger, Viewport } from "../types.js";
import type { InspectDerivation } from "./inspect.js";
import type { TrackDerivation } from "./track.js";
import type { GlDerivation } from "./gl-track.js";
import type { FramesDerivation } from "./frames.js";
import type { LottieDerivation } from "./lottie.js";
export interface Evidence {
    inspect?: InspectDerivation;
    track?: TrackDerivation;
    glTrack?: GlDerivation;
    frames?: FramesDerivation;
    lottie?: LottieDerivation;
    /** capture.json / frames.json / gl capture metadata, already flattened. */
    capture?: {
        url?: string;
        title?: string;
        viewport?: Viewport;
        fps?: number;
        trigger?: Trigger;
        durationMs?: number;
        clip?: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        renderer?: string;
        libs?: string[];
        fonts?: Array<{
            family?: string;
            status?: string;
        }>;
        frameCount?: number;
    };
}
export interface DeriveOptions {
    name: string;
    destination?: string;
    fidelity: Fidelity;
    additions: string[];
    /** Extra selectors from --track, used to name elements when a track has no inspect. */
    trackSelectors?: string[];
}
export interface DerivedSpec {
    spec: Spec;
    /** Rows dropped as duplicates of a stronger source, for the human report. */
    merged: string[];
}
export declare function deriveSpec(evidence: Evidence, opts: DeriveOptions): DerivedSpec;
/** The human template: one table an implementer can work straight down. */
export declare function specToMarkdown(spec: Spec): string;
