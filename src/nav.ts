// A link to a line in a PR diff: "#diff-<sha256(path)>R12", "L12" for the
// old side, or a range "R12-R15". Returns the file hash and the id of the
// first line's cell, or null for anything else.
export function lineAnchor(
  hash: string
): null | { file: string; line: string } {
  const m = hash.match(/^#?(diff-([0-9a-f]{64})[LR]\d+)(?:-[LR]\d+)?$/);
  return m ? { file: m[2], line: m[1] } : null;
}

// Picks the next or previous file to jump to. Indices refer to an ordered
// list of files; skip(i) says a file needs no attention.
export function nextFile(
  current: number,
  count: number,
  skip: (index: number) => boolean,
  dir: -1 | 1 = 1
): number {
  for (let index = current + dir; index >= 0 && index < count; index += dir) {
    if (!skip(index)) return index;
  }
  return -1;
}
