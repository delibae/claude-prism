export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FontInfo {
  family: string;
  size: number;
  weight: string;
  style: string;
}

export interface StructuredTextChar {
  c: string;
  quad: number[];
  origin: { x: number; y: number };
}

export interface StructuredTextSpan {
  font: FontInfo;
  chars: StructuredTextChar[];
}

export interface StructuredTextLine {
  bbox: Rect;
  wmode: number;
  x: number;
  y: number;
  text: string;
  font: {
    name: string;
    family: string;
    size: number;
    weight: string;
    style: string;
  };
}

export interface StructuredTextBlock {
  type: "text";
  bbox: Rect;
  lines: StructuredTextLine[];
}

export interface StructuredTextData {
  blocks: StructuredTextBlock[];
}

export interface LinkData {
  x: number;
  y: number;
  w: number;
  h: number;
  href: string;
  isExternal: boolean;
}

export interface PageSize {
  width: number;
  height: number;
}

export type WorkerRequest = [string, number, unknown[]];
export type WorkerResponse =
  | ["RESULT", number, unknown]
  | ["ERROR", number, { name: string; message: string }]
  | ["INIT", number, string[]];
