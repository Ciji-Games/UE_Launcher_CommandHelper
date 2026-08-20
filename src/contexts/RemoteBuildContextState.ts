import { createContext } from 'react';
import type { RemoteBuildProfile } from '../types';

export interface RemoteBuildContextValue {
  checkProfile: (profile: RemoteBuildProfile, runBuild?: boolean, force?: boolean, batchInvocation?: boolean) => Promise<void>;
  pullNow: (profile: RemoteBuildProfile) => Promise<void>;
  checking: boolean;
  scheduleNextAt: string | undefined;
  scheduleRunning: boolean;
  scheduleIntervalMinutes: number;
  setScheduleIntervalMinutes: (minutes: number) => Promise<void>;
  keepBuildsEnabled: boolean;
  keepBuildsCount: number;
  archiveOnly: boolean;
  applyScheduleSettings: (settings: { intervalMinutes: number; keepBuildsEnabled: boolean; keepBuildsCount: number; archiveOnly: boolean }) => Promise<void>;
}

export const RemoteBuildContext = createContext<RemoteBuildContextValue | null>(null);