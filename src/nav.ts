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
