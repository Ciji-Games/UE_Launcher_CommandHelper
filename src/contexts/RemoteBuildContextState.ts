import { createContext } from 'react';
import type { RemoteBuildProfile } from '../types';

export interface RemoteBuildContextValue {
  checkProfile: (profile: RemoteBuildProfile, runBuild?: boolean, force?: boolean) => Promise<void>;
  pullNow: (profile: RemoteBuildProfile) => Promise<void>;
  checking: boolean;
}

export const RemoteBuildContext = createContext<RemoteBuildContextValue | null>(null);