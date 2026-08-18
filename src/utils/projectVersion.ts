export function previewProjectVersion(version: string): string {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return version.trim();
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}