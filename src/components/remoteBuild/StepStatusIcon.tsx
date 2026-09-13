import React from 'react';
import type { PipelineStepId, StepPrerequisiteStatus } from '../../types';

export interface StepStatusIconProps {
  stepId: PipelineStepId;
  status: StepPrerequisiteStatus;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  className?: string;
}

export function StepStatusIcon({
  stepId,
  status,
  size = 'md',
  className = '',
}: StepStatusIconProps) {
  const sizeClasses = {
    sm: 'w-5 h-5 text-xs',
    md: 'w-7 h-7 text-sm',
    lg: 'w-9 h-9 text-base',
  }[size];

  const iconSizes = {
    sm: 12,
    md: 14,
    lg: 18,
  }[size];

  // Colors & badges
  let styleClasses = '';
  let content: React.ReactNode = null;

  switch (status) {
    case 'running':
      styleClasses = 'bg-sky-500/15 border-sky-400/50 text-sky-400 shadow-sm shadow-sky-500/20';
      content = (
        <svg
          className="animate-spin"
          width={iconSizes}
          height={iconSizes}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      );
      break;

    case 'waiting':
      styleClasses = 'bg-amber-500/15 border-amber-400/40 text-amber-300 animate-pulse';
      content = (
        <svg
          width={iconSizes}
          height={iconSizes}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 22h14" />
          <path d="M5 2h14" />
          <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
          <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
        </svg>
      );
      break;

    case 'checking':
      styleClasses = 'bg-cyan-500/15 border-cyan-400/40 text-cyan-300 animate-pulse';
      content = (
        <svg
          className="animate-spin"
          width={iconSizes}
          height={iconSizes}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2a10 10 0 0 0-10 10" />
        </svg>
      );
      break;

    case 'blocked':
      styleClasses = 'bg-rose-500/15 border-rose-500/50 text-rose-400 shadow-sm shadow-rose-500/10';
      content = (
        <svg
          width={iconSizes}
          height={iconSizes}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
      break;

    case 'warning':
      styleClasses = 'bg-amber-500/15 border-amber-400/40 text-amber-300';
      content = (
        <svg
          width={iconSizes}
          height={iconSizes}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      );
      break;

    case 'disabled':
      styleClasses = 'bg-slate-800/40 border-slate-700/40 text-slate-400 opacity-70';
      content = (
        <svg
          width={iconSizes}
          height={iconSizes}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
      break;

    case 'ready':
    default:
      styleClasses = 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400 shadow-sm shadow-emerald-500/10';
      content = (
        <svg
          width={iconSizes}
          height={iconSizes}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      );
      break;
  }

  return (
    <div
      className={`inline-flex items-center justify-center rounded-lg border transition-all duration-200 select-none ${sizeClasses} ${styleClasses} ${className}`}
      aria-label={`Step ${stepId} status: ${status}`}
    >
      {content}
    </div>
  );
}
