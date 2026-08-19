/**
 * Store keys and default values
 */

import type { CustomEngineEntry } from './types';

export const STORE_PATH = 'ue-launcher-store.json';

export const STORE_KEYS = {
  PROJECTS: 'projects',
  SCHEDULED_JOBS: 'scheduledJobs',
  UNREAL_VERSION_SELECTOR_PATH: 'unrealVersionSelectorPath',
  AUTO_SWITCH_BOOSTER: 'autoSwitchBooster',
  PRIORITY_BOOSTER: 'priorityBooster',
  START_WITH_WINDOWS: 'startWithWindows',
  CUSTOM_ENGINES: 'customEngines',
  DISABLED_ENGINE_PATHS: 'disabledEnginePaths',
  PROJECT_ENGINE_OVERRIDES: 'projectEngineOverrides',
  DEFAULT_ENGINE_BY_VERSION: 'defaultEngineByVersion',
  NOTIFICATION_ON_COMPLETE: 'notificationOnComplete',
  PREFERRED_IDE_ID: 'preferredIdeId',
  REMOTE_BUILD_PROFILES: 'remoteBuildProfiles',
  REMOTE_BUILD_ACTIVE_PROFILE: 'remoteBuildActiveProfile',
  REMOTE_BUILD_POLLING_INTERVAL: 'remoteBuildPollingInterval',
  GITHUB_ACCOUNT: 'githubAccount',
  GITHUB_REPOSITORY_CACHE: 'githubRepositoryCache',
} as const;

export const DEFAULT_SETTINGS = {
  unrealVersionSelectorPath: '',
  autoSwitchBooster: false,
  priorityBooster: 0, // 0=BelowNormal, 1=Normal, 2=AboveNormal, 3=High
  startWithWindows: false,
  notificationOnComplete: false,
  customEngines: [] as CustomEngineEntry[],
  disabledEnginePaths: [] as string[],
  projectEngineOverrides: {} as Record<string, string>,
  defaultEngineByVersion: {} as Record<string, string>,
  preferredIdeId: '',
  remoteBuildPollingInterval: 15,
};

/** Link entry for the Links tab. icon is optional asset key or undefined for default. */
export interface LinkEntry {
  url: string;
  label: string;
  icon?: 'ueIcon' | 'cppLogo' | 'fab' | 'logoBackend' | 'logoAcademy' | 'discord' | 'iconCPPGen' | 'iconLDA';
  /** When true, thumbnail fills the card with no padding. */
  fullThumbnail?: boolean;
}

/** Category with its links. */
export interface LinkCategory {
  name: string;
  links: LinkEntry[];
}

/** Links shown in the Links tab, grouped by category. From links.md. */
export const LINK_CATEGORIES: LinkCategory[] = [
  {
    name: 'Official links',
    links: [
      { url: 'https://forums.unrealengine.com/categories?tag=unreal-engine', label: 'Forums Unreal Engine', icon: 'ueIcon' },
      { url: 'https://docs.unrealengine.com/', label: 'Latest documentation', icon: 'ueIcon' },
      { url: 'https://www.fab.com/', label: 'Fab.com', icon: 'fab' },
    ],
  },
  {
    name: 'Community links',
    links: [
      { url: 'https://unreal-garden.com/', label: 'Unreal Garden', icon: 'ueIcon' },
      { url: 'https://www.unrealdirective.com/resources/asset-naming-conventions', label: 'Assets Naming convention', icon: 'ueIcon' },
      { url: 'https://discord.gg/unrealsource', label: 'Unreal Source', icon: 'discord' },
    ],
  },
  {
    name: 'Ciji Games',
    links: [
      { url: 'https://ciji.dev/', label: 'Gamedev backend', icon: 'logoBackend', fullThumbnail: true },
      { url: 'https://academy.cijigames.com/', label: 'French U.E Courses', icon: 'logoAcademy', fullThumbnail: true },
      { url: 'https://www.fab.com/sellers/Ciji%20Games', label: 'Ciji Games on FAB', icon: 'fab' },
      { url: 'https://www.fab.com/listings/6f1236ea-3587-4cdc-808c-1624ce0b9500', label: 'C++ Generator', icon: 'iconCPPGen', fullThumbnail: true },
      { url: 'https://www.fab.com/listings/e799c9aa-57f9-4840-8ad7-3a6b271cdd39', label: 'LD Assistant 2', icon: 'iconLDA', fullThumbnail: true },
    ],
  },
];
