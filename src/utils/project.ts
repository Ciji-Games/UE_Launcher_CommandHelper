/**
 * Project display utilities.
 */

import type { ProjectInfo, EngineEntry } from '../types';

/**
 * Returns the short engine version (e.g. "5.7") from a full version string.
 * - "5.7.1" → "5.7"
 * - "5.7" → "5.7"
 * - GUID or unknown format → returns as-is
 */
export function getShortEngineVersion(engineVersion: string): string {
  if (!engineVersion) return '';
  // Match semantic version pattern (e.g. 5.7, 5.7.1)
  const match = engineVersion.match(/^(\d+\.\d+)/);
  return match ? match[1] : engineVersion;
}

/**
 * Returns the project display label for dropdowns: "Project Name (5.7)"
 */
export function getProjectDisplayLabel(project: ProjectInfo): string {
  const short = getShortEngineVersion(project.engineVersion);
  const name = project.projectAlias?.trim() || project.projectName;
  return short ? `${name} (${short})` : name;
}

/**
 * Returns display label for an engine in dropdowns.
 * Custom engines: "DisplayName (version)", registry: "version"
 */
export function getEngineLabel(engine: EngineEntry): string {
  if (engine.displayName) {
    // If it's a custom engine from settings, it might have a name like "My Build"
    // If it's from HKCU builds, it might not have a name yet (displayName is None/undefined)
    return `${engine.displayName} (${engine.version})`;
  }
  if (engine.isCustom) {
    return `Custom: ${engine.version}`;
  }
  return engine.version;
}

/**
 * Options for engine Select dropdown: value=editorPath, label=display
 */
export function getEngineSelectOptions(
  engines: EngineEntry[]
): { value: string; label: string }[] {
  return engines.map((e) => ({
    value: e.editorPath,
    label: getEngineLabel(e),
  }));
}
