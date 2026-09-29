// Types for photos.js, for the tests (the dashboard itself is plain JavaScript).

export function squash(text: string): string;

export interface PhotoMatch<P> {
  file: string;
  product: P | null;
  by: "code" | "name" | null;
}

export function matchPhotos<P extends { name: string; sku?: string | null }>(fileNames: string[], products: P[]): PhotoMatch<P>[];
