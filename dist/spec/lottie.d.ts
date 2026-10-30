import { type RawRow } from "./row.js";
export interface LottieKeyframe {
    t?: number;
    s?: number[] | number;
    e?: number[] | number;
    i?: {
        x?: number | number[];
        y?: number | number[];
    };
    o?: {
        x?: number | number[];
        y?: number | number[];
    };
    h?: number;
}
export interface LottieProp {
    a?: number;
    k?: number | number[] | LottieKeyframe[];
    x?: string;
}
export interface LottieLayer {
    ind?: number;
    nm?: string;
    ty?: number;
    ip?: number;
    op?: number;
    st?: number;
    sr?: number;
    ks?: Record<string, LottieProp>;
    shapes?: unknown[];
    tt?: number;
}
export interface LottieFile {
    v?: string;
    nm?: string;
    fr?: number;
    ip?: number;
    op?: number;
    w?: number;
    h?: number;
    layers?: LottieLayer[];
    markers?: Array<{
        tm?: number;
        cm?: string;
        dr?: number;
    }>;
    assets?: unknown[];
}
export interface LottieDerivation {
    rows: RawRow[];
    notes: string[];
    facts: Record<string, string | number>;
    fps: number;
    totalMs: number;
    name: string;
}
export declare function deriveFromLottie(file: LottieFile, opts?: {
    fps?: number;
}): LottieDerivation;
