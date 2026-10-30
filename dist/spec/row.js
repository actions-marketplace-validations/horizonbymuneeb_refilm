// refilm — the intermediate row every evidence source produces, before spec assembly.
//
// Keeping this separate from `SpecRow` means a source never has to invent a stagger, an id or
// a confidence it cannot justify: those are decided once, in `derive.ts`, from the evidence.
export const roundTo = (n, digits = 2) => {
    const k = 10 ** digits;
    return Math.round(n * k) / k;
};
