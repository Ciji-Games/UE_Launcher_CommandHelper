/**
 * Scheduler tab - create, edit, and run named batch jobs (sequences of tools).
 */

import { useState, useEffect } from 'react';
import { useScheduledJobs } from '../hooks/useScheduledJobs';
import { useRunScheduledJob } from '../hooks/useRunScheduledJob';
import { useProcessMonitor } from '../hooks/useProcessMonitor';
import { hasBlockingProcessesForJob, getBlockingMessageForJob } from '../utils/jobBlocking';
import { ToolGroup } from './ToolGroup';
import { OutputLogPanel } from './OutputLogPanel';
import {
  StepParamPanelMap,
  StepParamPanelMapExtended,
  StepParamPanelLighting,
  StepParamPanelUProject,
  StepParamPanelArchive,
  StepParamPanelRegenerate,
  StepParamPanelPlugin,
  StepParamPanelLaunch,
  StepParamPanelMovieRenderQueue,
  StepParamPanelResavePackages,
} from './scheduler';
import type { ScheduledJob, ScheduledStep } from '../types';
import { SCHEDULABLE_STEPS } from '../types';

const MAP_STEP_IDS = ['delete_hlod', 'build_hlod', 'build_minimap'];

function getStepLabel(stepId: string): string {
  return SCHEDULABLE_STEPS.find((s) => s.id === stepId)?.label ?? stepId;
}

function StepParamPanel({
  step,
  value,
  onChange,
}: {
  step: ScheduledStep;
  value: Record<string, unknown>;
  onChange: (params: Record<string, unknown>) => void;
}) {
  if (MAP_STEP_IDS.includes(step.id)) {
    return <StepParamPanelMap value={value} onChange={onChange} />;
  }
  if (step.id === 'resave_packages') {
    return <StepParamPanelResavePackages value={value} onChange={onChange} />;
  }
  if (step.id === 'resave_actors' || step.id === 'foliage_builder' || step.id === 'navigation_data' || step.id === 'rename_duplicate') {
    return (
      <StepParamPanelMapExtended
        stepId={step.id}
        value={value}
        onChange={onChange}
      />
    );
  }
  if (step.id === 'build_lighting') {
    return <StepParamPanelLighting value={value} onChange={onChange} />;
  }
  if (step.id === 'cook') {
    return (
      <StepParamPanelUProject stepId="cook" value={value} onChange={onChange} />
    );
  }
  if (step.id === 'package') {
    return (
      <StepParamPanelUProject stepId="package" value={value} onChange={onChange} />
    );
  }
  if (step.id === 'build') {
    return (
      <StepParamPanelUProject stepId="build" value={value} onChange={onChange} />
    );
  }
  if (step.id === 'archive') {
    return <StepParamPanelArchive value={value} onChange={onChange} />;
  }
  if (step.id === 'regenerate') {
    return <StepParamPanelRegenerate value={value} onChange={onChange} />;
  }
  if (step.id === 'build_plugin') {
    return <StepParamPanelPlugin value={value} onChange={onChange} />;
  }
  if (step.id === 'launch') {
    return <StepParamPanelLaunch value={value} onChange={onChange} />;
  }
  if (step.id === 'movie_render_queue') {
    return <StepParamPanelMovieRenderQueue value={value} onChange={onChange} />;
  }
  return null;
}

interface SchedulerTabProps {
  outputOpenSignal?: number;
}

export function SchedulerTab({ outputOpenSignal = 0 }: SchedulerTabProps) {
  const { jobs, loading, addJob, updateJob, removeJob } = useScheduledJobs();
  const { runJob, running: runJobRunning } = useRunScheduledJob();
  const umapMonitor = useProcessMonitor('umap');
  const uprojectMonitor = useProcessMonitor('uproject');
  const regenerateMonitor = useProcessMonitor('regenerate');
  const monitors = {
    umap: umapMonitor,
    uproject: uprojectMonitor,
    regenerate: regenerateMonitor,
  };

  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [editingJob, setEditingJob] = useState<ScheduledJob | null>(null);
  const [runDialogJob, setRunDialogJob] = useState<ScheduledJob | null>(null);
  const [stopOnFailure, setStopOnFailure] = useState(true);
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set([0]));
  const [showOutputLog, setShowOutputLog] = useState(false);

  useEffect(() => {
    if (outputOpenSignal > 0) {
      setShowOutputLog(true);
    }
  }, [outputOpenSignal]);

  const selectedJob = jobs.find((j) => j.id === selectedJobId);

  useEffect(() => {
    if (editingJob) {
      setExpandedSteps(
        editingJob.steps.length > 0 ? new Set([0]) : new Set()
      );
    }
  }, [editingJob?.id]);

  const handleCreate = async () => {
    const newJob = await addJob({ name: 'New Job', steps: [] });
    setSelectedJobId(newJob.id);
    setEditingJob({ ...newJob });
  };

  const handleEdit = (job: ScheduledJob) => {
    setSelectedJobId(job.id);
    setEditingJob({ ...job });
  };

  const handleEditName = (name: string) => {
    if (!editingJob) return;
    setEditingJob({ ...editingJob, name });
  };

  const handleSave = async () => {
    if (!editingJob) return;
    const jobToSave: ScheduledJob = {
      ...editingJob,
      steps: editingJob.steps.map((step) => {
        if (step.id !== 'package') return step;
        const { projectVersion, newProjectVersion, ...params } = step.params;
        void projectVersion;
        void newProjectVersion;
        return { ...step, params };
      }),
    };
    await updateJob(editingJob.id, jobToSave);
    setEditingJob(null);
  };

  const handleCancelEdit = () => {
    setEditingJob(null);
  };

  const handleAddStep = (stepId: string) => {
    if (!editingJob) return;
    const newStep: ScheduledStep = { id: stepId, params: {} };
    const newIndex = editingJob.steps.length;
    setEditingJob({
      ...editingJob,
      steps: [...editingJob.steps, newStep],
    });
    setExpandedSteps((prev) => new Set([...prev, newIndex]));
  };

  const toggleStepExpanded = (index: number) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handleRemoveStep = (index: number) => {
    if (!editingJob) return;
    setEditingJob({
      ...editingJob,
      steps: editingJob.steps.filter((_, i) => i !== index),
    });
    setExpandedSteps((prev) =>
      new Set(
        [...prev]
          .filter((i) => i !== index)
          .map((i) => (i > index ? i - 1 : i))
      )
    );
  };

  const handleMoveStep = (index: number, direction: 'up' | 'down') => {
    if (!editingJob) return;
    const newSteps = [...editingJob.steps];
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= newSteps.length) return;
    [newSteps[index], newSteps[target]] = [newSteps[target], newSteps[index]];
    setEditingJob({ ...editingJob, steps: newSteps });
    setExpandedSteps((prev) =>
      new Set(
        [...prev].map((i) => {
          if (i === index) return target;
          if (i === target) return index;
          return i;
        })
      )
    );
  };

  const handleStepParamsChange = (index: number, params: Record<string, unknown>) => {
    if (!editingJob) return;
    const newSteps = [...editingJob.steps];
    newSteps[index] = { ...newSteps[index], params };
    setEditingJob({ ...editingJob, steps: newSteps });
  };

  const handleRun = (job: ScheduledJob) => {
    setRunDialogJob(job);
    setStopOnFailure(true);
  };

  const handleCancelRun = () => {
    setRunDialogJob(null);
  };

  const handleConfirmRun = async () => {
    const job = runDialogJob;
    if (
      !job ||
      job.steps.length === 0 ||
      runJobRunning ||
      hasBlockingProcessesForJob(job, monitors)
    )
      return;

    setRunDialogJob(null);
    setShowOutputLog(true);
    await runJob(job, { stopOnFailure });
  };

  const jobWithBlocking = runDialogJob ?? selectedJob;
  const showBlockingBanner =
    jobWithBlocking && hasBlockingProcessesForJob(jobWithBlocking, monitors);

  return (
    <div className="flex flex-col gap-6 flex-1 min-h-0 overflow-hidden">
      {showBlockingBanner && (
          <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100/90">
            <p className="font-medium">Cannot run: Unreal Engine or related tools are running</p>
            <p className="mt-1 text-amber-100/80">
              Close Unreal Editor, Visual Studio, or Rider before running jobs.
            </p>
          </div>
        )}

      <div
        className={`flex gap-4 min-h-0 overflow-hidden flex-1 ${
          showOutputLog ? 'flex-[4_1_0]' : 'flex-[6_1_0]'
        }`}
      >
        {/* Left: Job list */}
        <div className="w-64 shrink-0 flex flex-col">
          <nav className="flex flex-col gap-px rounded-lg overflow-hidden bg-slate-800/50 border border-slate-600/60">
            <div className="px-4 py-2.5 rounded-t-lg bg-slate-700/40 border-b border-slate-600/60">
              <h3 className="font-medium text-slate-200 text-sm">Jobs</h3>
            </div>
            {loading ? (
              <p className="px-4 py-3 text-slate-400 text-sm">Loading...</p>
            ) : jobs.length === 0 ? (
              <p className="px-4 py-3 text-slate-400 text-sm">No jobs yet</p>
            ) : (
              jobs.map((job) => (
                <div
                  key={job.id}
                  className={`flex items-center justify-between gap-2 px-4 py-2 border-b border-slate-700/50 last:border-b-0 ${
                    selectedJobId === job.id
                      ? 'bg-sky-600/20 text-sky-100'
                      : 'text-slate-300 hover:bg-slate-700/50'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => !editingJob && setSelectedJobId(job.id)}
                    disabled={!!editingJob}
                    className={`flex-1 text-left min-w-0 truncate ${editingJob ? 'cursor-not-allowed opacity-70' : ''}`}
                  >
                    {job.name}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateJob(job.id, { pinned: !job.pinned });
                    }}
                    className={`shrink-0 p-1 rounded transition-colors ${
                      job.pinned
                        ? 'text-sky-400 hover:text-sky-300'
                        : 'text-slate-500 hover:text-slate-400'
                    }`}
                    title={job.pinned ? 'Unpin from launcher' : 'Pin to launcher'}
                    aria-label={job.pinned ? 'Unpin' : 'Pin'}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                    </svg>
                  </button>
                  <span className="text-xs text-slate-500 shrink-0">
                    {job.steps.length} steps
                  </span>
                </div>
              ))
            )}
            <div className="p-2 border-t border-slate-600/60">
              <button
                type="button"
                onClick={handleCreate}
                disabled={!!editingJob}
                className={`w-full rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  editingJob
                    ? 'bg-slate-600/60 text-slate-500 cursor-not-allowed'
                    : 'bg-sky-600/80 hover:bg-sky-500/80 text-white'
                }`}
              >
                Create Job
              </button>
            </div>
          </nav>
        </div>

        {/* Right: Job editor */}
        <div className="flex-1 min-w-0 min-h-0 rounded-lg border border-slate-600/60 bg-slate-800/30 p-6 overflow-y-auto">
          {editingJob ? (
            <ToolGroup
              title="Edit Job"
              description="Configure job name and steps. Add steps from the catalog and set their parameters."
            >
              <div className="flex flex-col gap-4">
                <div>
                  <label className="block text-sm text-slate-300 mb-1">Job name</label>
                  <input
                    type="text"
                    value={editingJob.name}
                    onChange={(e) => handleEditName(e.target.value)}
                    className="w-full rounded-md bg-slate-700/50 border border-slate-600 text-slate-100 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500/30"
                    placeholder="e.g. HLOD Pipeline"
                  />
                </div>

                <div>
                  <label className="block text-sm text-slate-300 mb-2">Add step</label>
                  <div className="flex flex-wrap gap-2">
                    {SCHEDULABLE_STEPS.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => handleAddStep(s.id)}
                        className="rounded-md px-3 py-1.5 bg-slate-700/60 hover:bg-slate-600/60 text-slate-200 text-sm transition-colors"
                      >
                        + {s.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm text-slate-300 mb-2">Steps</label>
                  {editingJob.steps.length === 0 ? (
                    <p className="text-slate-500 text-sm">No steps. Add steps above.</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {editingJob.steps.map((step, index) => {
                        const isExpanded = expandedSteps.has(index);
                        return (
                          <div
                            key={`${step.id}-${index}`}
                            className="rounded-lg border border-slate-600/60 bg-slate-700/30 overflow-hidden"
                          >
                            <button
                              type="button"
                              onClick={() => toggleStepExpanded(index)}
                              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-700/50 transition-colors"
                            >
                              <span className="font-medium text-slate-100">
                                {index + 1}. {getStepLabel(step.id)}
                              </span>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleMoveStep(index, 'up');
                                  }}
                                  disabled={index === 0}
                                  className="rounded px-2 py-1 bg-slate-600/80 hover:bg-slate-500/80 disabled:opacity-50 text-slate-200 text-xs"
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleMoveStep(index, 'down');
                                  }}
                                  disabled={index === editingJob!.steps.length - 1}
                                  className="rounded px-2 py-1 bg-slate-600/80 hover:bg-slate-500/80 disabled:opacity-50 text-slate-200 text-xs"
                                >
                                  ↓
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRemoveStep(index);
                                  }}
                                  className="rounded px-2 py-1 bg-slate-600/80 hover:bg-red-600/70 text-slate-200 text-xs"
                                >
                                  Remove
                                </button>
                                <span
                                  className={`inline-block text-slate-400 text-xs transition-transform ${
                                    isExpanded ? 'rotate-180' : ''
                                  }`}
                                >
                                  ▼
                                </span>
                              </div>
                            </button>
                            {isExpanded && (
                              <div className="px-4 pb-4 pt-0 border-t border-slate-600/60">
                                <StepParamPanel
                                  step={step}
                                  value={step.params}
                                  onChange={(p) => handleStepParamsChange(index, p)}
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleSave}
                    className="rounded-md px-4 py-2 bg-sky-600/80 hover:bg-sky-500/80 text-white font-medium transition-colors"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    className="rounded-md px-4 py-2 bg-slate-600/80 hover:bg-slate-500/80 text-slate-200 font-medium transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </ToolGroup>
          ) : selectedJob ? (
            <div className="text-slate-400">
              <p className="mb-2 text-slate-100 font-medium">{selectedJob.name}</p>
              <p className="text-sm mb-4">
                {selectedJob.steps.length} steps:{' '}
                {selectedJob.steps.map((s) => getStepLabel(s.id)).join(' → ')}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => handleEdit(selectedJob)}
                  className="rounded-md px-3 py-1.5 bg-slate-600/80 hover:bg-slate-500/80 text-slate-200 text-sm transition-colors"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => handleRun(selectedJob)}
                  disabled={
                    selectedJob.steps.length === 0 ||
                    hasBlockingProcessesForJob(selectedJob, monitors) ||
                    runJobRunning
                  }
                  title="Executes the job steps in sequence. Each step runs its corresponding Unreal/Git command (HLOD, Cook, etc.)."
                  className={`rounded-md px-3 py-1.5 bg-sky-600/80 hover:bg-sky-500/80 disabled:bg-slate-600/80 disabled:text-slate-500 text-white text-sm transition-colors ${
                    getBlockingMessageForJob(selectedJob, monitors) ? 'text-xs' : 'text-sm'
                  }`}
                >
                  {runJobRunning
                    ? 'Running...'
                    : getBlockingMessageForJob(selectedJob, monitors) ?? 'Run'}
                </button>
                <button
                  type="button"
                  onClick={() => removeJob(selectedJob.id).then(() => setSelectedJobId(null))}
                  className="rounded-md px-3 py-1.5 bg-slate-600/80 hover:bg-red-600/70 text-slate-200 text-sm transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          ) : (
            <p className="text-slate-500">Select or create a job to get started.</p>
          )}
        </div>
      </div>

      {/* Output Log - hidden by default, shown when job runs or user toggles */}
      <div
        className={`flex flex-col min-w-0 transition-all overflow-hidden rounded-lg border border-slate-600/60 bg-slate-800/40 ${
          showOutputLog ? 'flex-[6_1_0] min-h-0' : 'shrink-0'
        }`}
      >
        <button
          type="button"
          onClick={() => setShowOutputLog((prev) => !prev)}
          className="flex items-center justify-between w-full px-4 py-2 hover:bg-slate-700/50 text-left transition-colors"
        >
          <span className="text-sm font-medium text-slate-300">
            Output Log
          </span>
          <span
            className={`inline-block text-slate-400 text-xs transition-transform ${
              showOutputLog ? 'rotate-180' : ''
            }`}
          >
            ▼
          </span>
        </button>
        {showOutputLog && (
          <div className="flex-1 min-h-0 flex flex-col min-w-0 overflow-hidden border-t border-slate-600/60 p-4">
            <OutputLogPanel />
          </div>
        )}
      </div>

      {/* Run dialog */}
      {runDialogJob && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 backdrop-blur-sm">
          <div className="rounded-lg bg-slate-800 border border-slate-600 p-6 w-full max-w-md shadow-xl">
            <h3 className="text-lg font-semibold text-slate-100 mb-4">
              Run: {runDialogJob.name}
            </h3>
            <p className="text-slate-400 text-sm mb-4">
              {runDialogJob.steps.length} steps will run in sequence.
            </p>
            <label className="flex items-center gap-2 text-slate-300 text-sm cursor-pointer mb-4">
              <input
                type="checkbox"
                checked={stopOnFailure}
                onChange={(e) => setStopOnFailure(e.target.checked)}
                className="rounded border-slate-600 bg-slate-700 text-sky-500 focus:ring-sky-500/50"
              />
              Stop on first failure
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleConfirmRun()}
                disabled={
                  runJobRunning ||
                  (runDialogJob
                    ? hasBlockingProcessesForJob(runDialogJob, monitors)
                    : false)
                }
                title="Executes the job steps in sequence. Each step runs its corresponding Unreal/Git command."
                className="rounded-md px-4 py-2 bg-sky-600/80 hover:bg-sky-500/80 disabled:bg-slate-600 disabled:text-slate-500 text-white font-medium transition-colors"
              >
                {runJobRunning
                  ? 'Running...'
                  : runDialogJob
                    ? getBlockingMessageForJob(runDialogJob, monitors) ?? 'Run'
                    : 'Run'}
              </button>
              <button
                type="button"
                onClick={handleCancelRun}
                disabled={runJobRunning}
                className="rounded-md px-4 py-2 bg-slate-600 hover:bg-slate-500 text-slate-200 font-medium transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
