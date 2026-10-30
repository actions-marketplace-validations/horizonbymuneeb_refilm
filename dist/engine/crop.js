// refilm — PNG cropping.
//
// Frames come out of a screenshot already at device pixels; --selector/--pad/--clip crop them to the
// element of interest. Cropping in-process with pngjs keeps the frame bytes reproducible (ffmpeg's PNG
// encoder is not bit-stable across builds), which the byte-identical capture guarantee depends on.
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
/** A crop rect in CSS pixels clamped to the screenshot, converted to device pixels. */
export function deviceCrop(rect, scale, width, height) {
    const x = Math.max(0, Math.round(rect.x * scale));
    const y = Math.max(0, Math.round(rect.y * scale));
    const w = Math.min(Math.round(rect.width * scale), width - x);
    const h = Math.min(Math.round(rect.height * scale), height - y);
    if (!(w > 0) || !(h > 0))
        return undefined;
    return { x, y, width: w, height: h };
}
/** Crops one PNG file in place (same path, smaller image). */
export function cropPngFile(file, crop) {
    const source = PNG.sync.read(readFileSync(file));
    const x = Math.max(0, Math.min(crop.x, source.width - 1));
    const y = Math.max(0, Math.min(crop.y, source.height - 1));
    const width = Math.max(1, Math.min(crop.width, source.width - x));
    const height = Math.max(1, Math.min(crop.height, source.height - y));
    const out = new PNG({ width, height });
    PNG.bitblt(source, out, x, y, width, height, 0, 0);
    writeFileSync(file, PNG.sync.write(out));
}
/** Reads width/height of a PNG without decoding pixels. */
export function pngSize(file) {
    const buf = readFileSync(file);
    // IHDR width/height are the first two big-endian uint32s after the 8-byte signature + 8-byte chunk header
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
