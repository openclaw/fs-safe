import path from "node:path";
import { isPathInside } from "./path.js";
import { probePathCaseInsensitiveSync } from "./path-case.js";
import { observeMutationPath, type MutationPathObservation } from "./pinned-mutation-observation.js";

function foldedName(name: string): string {
  // Decompose before folding so combining marks precede an expanded Greek subscript.
  // Default folding preserves dotless i even though its uppercase mapping is I.
  return name.normalize("NFD").replace(/[^\u0131]+/gu,
    part => part.toLowerCase().toUpperCase().toLowerCase()).normalize("NFC");
}

function asciiCasePair(left: string, right: string): boolean {
  return /^[\x00-\x7f]*$/.test(left) && /^[\x00-\x7f]*$/.test(right) &&
    left.toLowerCase() === right.toLowerCase();
}

/** Cache observations only within one synchronous policy check, never across mutations or callbacks. */
export function createMutationDenyMatcher(): (
  target: string, denied: string, prefix: boolean, protectAncestors?: boolean,
) => boolean {
  const observations = new Map<string, MutationPathObservation | undefined>();
  const caseObservations = new Map<string, boolean | undefined>();
  const observe = (pathname: string) => {
    if (!observations.has(pathname)) observations.set(pathname, observeMutationPath(pathname));
    return observations.get(pathname);
  };
  const prospectiveInside = (parent: string, child: string): boolean => {
    const root = path.parse(parent).root;
    if (root !== path.parse(child).root) return false;
    const left = parent.slice(root.length).split(path.sep);
    const right = child.slice(root.length).split(path.sep).slice(0, left.length);
    if (left.length !== right.length || !left.every((name, i) => foldedName(name) === foldedName(right[i]!))) {
      return false;
    }
    // Byte-identical relations were already handled without any observations.
    if (left.every((name, i) => name === right[i])) return false;
    const alignedChild = path.join(root, ...right);
    const a = observe(parent);
    const b = observe(alignedChild);
    if (!a || !b) return true;
    // Distinct existing ancestors are real objects, not prospective aliases.
    if (a.canonicalAncestor !== b.canonicalAncestor ||
      a.missingSegments.length === 0 || a.missingSegments.length !== b.missingSegments.length) return false;
    const missingLeft = a.missingSegments;
    const missingRight = b.missingSegments;
    if (!missingLeft.every((name, i) => foldedName(name) === foldedName(missingRight[i]!))) return false;
    const difference = missingLeft.findIndex((name, i) => name !== missingRight[i]);
    if (difference === -1) return true;
    // A read-only ASCII observation can disprove aliasing at this existing parent.
    // It cannot prove Unicode sensitivity or the behavior of a future directory.
    if (difference === 0 && asciiCasePair(missingLeft[0]!, missingRight[0]!)) {
      if (!caseObservations.has(a.canonicalAncestor)) {
        caseObservations.set(a.canonicalAncestor, probePathCaseInsensitiveSync(
          path.join(a.canonicalAncestor, missingLeft[0]!), { allowTemporaryProbe: false },
        ));
      }
      if (caseObservations.get(a.canonicalAncestor) === false) return false;
    }
    // Suffix probing writes directories. Policy admission has no authority for
    // those side effects, so unproven case/normalization equivalence fails closed.
    return true;
  };
  return (target, denied, prefix, protectAncestors = false) => {
    if ((isPathInside(denied, target) && (prefix || isPathInside(target, denied))) ||
      (protectAncestors && isPathInside(target, denied))) return true;
    return ((prefix || target.split(path.sep).length === denied.split(path.sep).length) &&
      prospectiveInside(denied, target)) || (protectAncestors && prospectiveInside(target, denied));
  };
}
