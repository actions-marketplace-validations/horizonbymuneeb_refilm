import { RefilmError } from "../lib.js";
export declare const help = "\nrefilm gl \u2014 read a GPU trace written by \"refilm record --gl\".\n\n  refilm gl summary  <captureDir>\n      canvases and their renderer settings, three.js scene graph and mixers, shader programs with their\n      attribute layouts, draw order per frame, textures, and every animated channel.\n\n  refilm gl channels <captureDir> [--grep RE] [--series KEY]\n      list channels (kind, range, when they change), or print one channel as [[t, value], \u2026] for fitting.\n\n  refilm gl compare  --ref <dir> --clone <dir> [--grep RE] [--map \"a=b,c=d\"] [--timing 80] [--out report.md]\n      canvas attributes, renderer settings and draw structure side by side, then every animated channel:\n      same kind, start and end within --timing ms, mean value error \u2264 5 % of the reference range.\n      Exit code is 1 when any channel fails.\n\n  --json   machine-readable result on stdout\n";
export declare function run(argv: string[], ctx: {
    json: boolean;
}): Promise<number>;
export { RefilmError };
