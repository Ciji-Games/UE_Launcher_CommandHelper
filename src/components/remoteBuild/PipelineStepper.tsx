import React from 'react';
import type { PipelineStepId, ProfilePrerequisites, RemoteBuildProfile, RemoteBuildStageStatus } from '../../types';
import { StepStatusIcon } from './StepStatusIcon';
import { StepChecklistTooltip } from './StepChecklistTooltip';
import { getStepStatusWithLiveStage } from '../../utils/remoteBuildPrerequisites';

export interface PipelineStepperProps {
  profile: RemoteBuildProfile;
  prerequisites?: ProfilePrerequisites;
  className?: string;
}

const PIPELINE_STEPS: { id: PipelineStepId; label: string; shortLabel: string }[] = [
  { id: 'clone', label: 'Clone Repository', shortLabel: 'Clone' },
  { id: 'repo', label: 'Git Sync & Fetch', shortLabel: 'Repo Sync' },
  { id: 'package', label: 'Unreal Packaging', shortLabel: 'Package' },
  { id: 'zip', label: 'Zip Compression', shortLabel: 'Zip' },
  { id: 'cleanup', label: 'Retention Cleanup', shortLabel: 'Cleanup' },
];

export function PipelineStepper({
  profile,
  prerequisites,
  className = '',
}: PipelineStepperProps) {
  const isZipDisabled = prerequisites?.steps.zip?.status === 'disabled';
  const visibleSteps = PIPELINE_STEPS.filter((step) => {
    if (step.id === 'zip' && isZipDisabled) {
      return false;
    }
    return true;
  });

  const getStageProgress = (stepId: PipelineStepId): number | undefined => {
    if (stepId === 'clone') return profile.cloneProgress;
    if (stepId === 'repo') return profile.repoProgress;
    if (stepId === 'package') return profile.buildProgress;
    if (stepId === 'zip') return profile.zipProgress;
    return undefined;
  };

  const getStageStatus = (stepId: PipelineStepId): RemoteBuildStageStatus | undefined => {
    return profile.progressStages ? profile.progressStages[stepId] : undefined;
  };

  return (
    <div className={`w-full py-2.5 px-3 rounded-xl bg-slate-950/60 border border-slate-800/80 ${className}`}>
      <div className="flex items-center justify-between relative">
        {visibleSteps.map((step, index) => {
          const liveStage = getStageStatus(step.id);
          const prereqReport = prerequisites?.steps[step.id] ?? {
            stepId: step.id,
            label: step.label,
            status: 'ready' as const,
            items: [],
          };

          const isProfileRunning =
            profile.lastStatus === 'running' ||
            profile.lastStatus === 'pulling' ||
            profile.lastStatus === 'fetching' ||
            profile.lastStatus === 'checking';
          const isProfileBlocked = profile.lastStatus === 'blocked';

          // Check if any previous stage is running or if build is running and this step has not started
          const isAnyPrecedingRunning = visibleSteps.slice(0, index).some((prevStep) => {
            const prevLive = getStageStatus(prevStep.id);
            const isPrevCloning = prevStep.id === 'clone' && profile.cloneStatus === 'cloning';
            return (prevLive === 'running' && isProfileRunning) || isPrevCloning;
          });

          let effectiveStatus = getStepStatusWithLiveStage(
            step.id,
            prereqReport.status,
            liveStage,
            profile.lastStatus
          );

          if (prereqReport.status !== 'disabled') {
            if (liveStage === 'failed' || prereqReport.status === 'blocked' || (isProfileBlocked && (liveStage === 'running' || step.id === 'repo'))) {
              effectiveStatus = 'blocked';
            } else if (isProfileRunning && (liveStage === 'running' || (step.id === 'clone' && profile.cloneStatus === 'cloning'))) {
              effectiveStatus = 'running';
            } else if (liveStage === 'success') {
              effectiveStatus = 'ready';
            } else if (isProfileRunning && (isAnyPrecedingRunning || !liveStage || liveStage === 'pending')) {
              effectiveStatus = 'waiting';
            }
          }

          const displayReport = {
            ...prereqReport,
            status: effectiveStatus,
          };

          const progress = getStageProgress(step.id);
          const isLast = index === visibleSteps.length - 1;

          return (
            <React.Fragment key={step.id}>
              {/* Step item */}
              <div className="flex flex-col items-center group relative z-10">
                <StepChecklistTooltip report={displayReport} position="top">
                  <div className="flex flex-col items-center cursor-pointer p-1 rounded-lg transition-transform hover:scale-105 active:scale-95 focus:outline-none focus:ring-1 focus:ring-sky-500">
                    <div className="relative">
                      <StepStatusIcon
                        stepId={step.id}
                        status={effectiveStatus}
                        size="md"
                      />
                      {effectiveStatus === 'running' && (
                        <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-sky-500" />
                        </span>
                      )}
                    </div>
                    <span className="mt-1.5 text-[11px] font-medium tracking-tight text-slate-300 group-hover:text-sky-300 transition-colors whitespace-nowrap">
                      {step.shortLabel}
                    </span>
                    {typeof progress === 'number' && effectiveStatus === 'running' && (
                      <span className="text-[10px] font-mono text-sky-400 font-semibold">
                        {Math.round(progress)}%
                      </span>
                    )}
                  </div>
                </StepChecklistTooltip>
              </div>

              {/* Connecting line */}
              {!isLast && (
                <div className="flex-1 mx-2 relative flex items-center">
                  <div className="h-0.5 w-full bg-slate-800 rounded-full overflow-hidden">
                    {effectiveStatus === 'running' && (
                      <div className="h-full bg-gradient-to-r from-sky-500 to-cyan-400 animate-pulse w-full" />
                    )}
                    {effectiveStatus === 'ready' && liveStage === 'success' && (
                      <div className="h-full bg-emerald-500 w-full" />
                    )}
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
