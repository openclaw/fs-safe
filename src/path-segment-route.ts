import path from "node:path";

export type PathSegmentRoute = Readonly<{
  joined: string;
  offsets: readonly number[];
}>;

export function createPathSegmentRoute(segments: readonly string[]): PathSegmentRoute {
  const offsets = new Array<number>(segments.length + 1);
  let cursor = 0;
  for (let index = 0; index < segments.length; index += 1) {
    offsets[index] = cursor;
    cursor += segments[index]!.length;
    if (index + 1 < segments.length) cursor += path.sep.length;
  }
  offsets[segments.length] = cursor;
  return Object.freeze({ joined: segments.join(path.sep), offsets: Object.freeze(offsets) });
}

// Select the immutable suffix by character offset so callers perform at most
// one path normalization without copying a shrinking segment array.
export function joinPathSegmentRoute(
  base: string,
  route: PathSegmentRoute,
  offset: number,
  tail?: string,
): string {
  const start = route.offsets[offset];
  if (start === undefined) throw new RangeError("path segment offset is outside the route");
  const suffix = route.joined.slice(start);
  if (suffix) return tail === undefined ? path.join(base, suffix) : path.join(base, suffix, tail);
  return tail === undefined ? base : path.join(base, tail);
}
