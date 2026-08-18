import { check, type Update } from '@tauri-apps/plugin-updater';

const LATEST_RELEASE_URL = 'https://api.github.com/repos/Ciji-Games/UE_Launcher_CommandHelper/releases/latest';
const RELEASE_PAGE_URL = 'https://github.com/Ciji-Games/UE_Launcher_CommandHelper/releases/tag';

export interface AppVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface UpdateInfo {
  tag: string;
  url: string;
  version: string;
  notes?: string;
  update?: Update;
}

export function parseAppVersion(version: string): AppVersion | null {
  return parseVersion(version, /^(\d+)\.(\d+)\.(\d+)$/);
}

export function parseReleaseTag(tag: string): AppVersion | null {
  return parseVersion(tag, /^app-v(\d+)\.(\d+)\.(\d+)$/);
}

function parseVersion(value: string, pattern: RegExp): AppVersion | null {
  const match = pattern.exec(value);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareVersions(left: AppVersion, right: AppVersion): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  const installedVersion = parseAppVersion(currentVersion);
  if (!installedVersion) {
    console.error('Unable to check for updates: invalid installed app version.');
    return null;
  }

  try {
    const updaterResult = await check();
    if (updaterResult) {
      return {
        tag: `app-v${updaterResult.version}`,
        url: `${RELEASE_PAGE_URL}/app-v${updaterResult.version}`,
        version: updaterResult.version,
        notes: updaterResult.body ?? undefined,
        update: updaterResult,
      };
    }
    return null;
  } catch (updaterError) {
    console.warn('Signed updater check unavailable; using release-page fallback:', updaterError);
  }

  try {
    const response = await fetch(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) {
      throw new Error(`GitHub returned HTTP ${response.status}.`);
    }

    const metadata: unknown = await response.json();
    if (!isReleaseMetadata(metadata)) {
      throw new Error('GitHub response did not contain a valid release tag.');
    }

    const remoteVersion = parseReleaseTag(metadata.tag_name);
    if (!remoteVersion || compareVersions(remoteVersion, installedVersion) <= 0) {
      return null;
    }

    return {
      tag: metadata.tag_name,
      url: `${RELEASE_PAGE_URL}/${metadata.tag_name}`,
      version: `${remoteVersion.major}.${remoteVersion.minor}.${remoteVersion.patch}`,
    };
  } catch (error) {
    console.error('Failed to check for updates:', error);
    return null;
  }
}

function isReleaseMetadata(value: unknown): value is { tag_name: string } {
  return typeof value === 'object' && value !== null && 'tag_name' in value && typeof value.tag_name === 'string';
}