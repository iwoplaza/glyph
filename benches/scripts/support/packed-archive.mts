export function packedArchiveDependency(entries: readonly string[]): string {
  const archives = entries.filter((entry) => entry.endsWith('.tgz'));
  if (archives.length !== 1) {
    throw new Error(`pnpm pack produced ${String(archives.length)} archives; expected exactly one`);
  }
  return `file:archives/${archives[0]}`;
}
