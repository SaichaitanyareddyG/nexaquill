"use client";

import React from "react";

type GuidedTourStep = {
  title: string;
  body: string;
  cta?: string;
};

type GuidedTourProps = {
  step: GuidedTourStep;
  stepIndex: number;
  totalSteps: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  isLast: boolean;
};

export function GuidedTour({
  step,
  stepIndex,
  totalSteps,
  onNext,
  onBack,
  onSkip,
  isLast,
}: GuidedTourProps): JSX.Element {
  return (
    <div className="guided-tour-overlay" role="dialog" aria-modal="true" aria-labelledby="guided-tour-title">
      <div className="guided-tour-card">
        <header className="guided-tour-card__header">
          <p className="guided-tour-card__progress">
            Step {stepIndex + 1} of {totalSteps}
          </p>
          <button type="button" className="guided-tour-card__skip" onClick={onSkip}>
            Skip tour
          </button>
        </header>
        <div className="guided-tour-card__body">
          <h3 id="guided-tour-title">{step.title}</h3>
          <p>{step.body}</p>
        </div>
        <footer className="guided-tour-card__footer">
          <button
            type="button"
            className="guided-tour-card__back"
            onClick={onBack}
            disabled={stepIndex === 0}
          >
            Back
          </button>
          <button type="button" className="guided-tour-card__next" onClick={onNext}>
            {isLast ? step.cta ?? "Finish" : step.cta ?? "Next"}
          </button>
        </footer>
      </div>
    </div>
  );
}
