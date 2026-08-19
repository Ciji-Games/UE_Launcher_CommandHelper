import { useContext } from 'react';
import { RemoteBuildContext } from '../contexts/RemoteBuildContextState';

export function useRemoteBuild() {
  const context = useContext(RemoteBuildContext);
  if (!context) throw new Error('useRemoteBuild must be used within RemoteBuildProvider');
  return context;
}