export interface CropRect {
    x: number;
    y: number;
    width: number;
    height: number;
}
/** A crop rect in CSS pixels clamped to the screenshot, converted to device pixels. */
export declare function deviceCrop(rect: CropRect, scale: number, width: number, height: number): CropRect | undefined;
/** Crops one PNG file in place (same path, smaller image). */
export declare function cropPngFile(file: string, crop: CropRect): void;
/** Reads width/height of a PNG without decoding pixels. */
export declare function pngSize(file: string): {
    width: number;
    height: number;
};
