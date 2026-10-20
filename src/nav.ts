// Picks the next or previous file to jump to. Indices refer to an ordered
// list of files; skip(i) says a file needs no attention.
export function nextFile(current: number, count: number, skip: (i: number) => boolean, dir: 1 | -1 = 1): number {
  for (let i = current + dir; i >= 0 && i < count; i += dir) {
    if (!skip(i)) return i;
  }
  return -1;
}
