"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import type { LearningRoadmap, RoadmapStep } from "@/types";
import { Target } from "lucide-react";
import { GoalFromStepForm } from "./GoalFromStepForm";
import { StepPlaylistSuggestions } from "./StepPlaylistSuggestions";

// ── Read-only view: description as a summary line, details as bullets. ──

export function RoadmapView({
  roadmap,
  categoryName,
  onCreateGoal,
}: {
  roadmap: LearningRoadmap | undefined;
  categoryName: string;
  onCreateGoal: (step: RoadmapStep, index: number, linkedPlaylists: { id: string; title: string }[]) => Promise<void>;
}) {
  const [goalStepIndex, setGoalStepIndex] = React.useState<number | null>(null);
  const [creatingGoal, setCreatingGoal] = React.useState(false);

  if (!roadmap || roadmap.steps.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
        No roadmap yet for this level. Use <strong>Generate</strong> above, or switch to{" "}
        <strong>Customize</strong> to write your own.
      </p>
    );
  }

  return (
    <ol className="space-y-2">
      {roadmap.steps.map((step, index) => (
        <li key={`${roadmap.id}-${index}`} className="rounded-md border border-border bg-background p-3 text-sm">
          <div className="flex gap-2">
            <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-semibold text-accent">
              {step.week ?? index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {step.week ? <span className="text-muted-foreground">Week {step.week} — </span> : null}
                {step.title}
              </div>
              {step.description && <p className="mt-0.5 text-muted-foreground">{step.description}</p>}
              {step.details && step.details.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">
                  {step.details.map((detail, i) => (
                    <li key={i}>{detail}</li>
                  ))}
                </ul>
              )}

              {/* Phase C2: "here's a roadmap" → "here's a roadmap with
                  trackable commitments". This is the gap between Study Lamp
                  and a plain YouTube playlist. */}
              {goalStepIndex === index ? (
                <GoalFromStepForm
                  step={step}
                  index={index}
                  busy={creatingGoal}
                  onCancel={() => setGoalStepIndex(null)}
                  onConfirm={async (linkedPlaylists) => {
                    setCreatingGoal(true);
                    try {
                      await onCreateGoal(step, index, linkedPlaylists);
                      setGoalStepIndex(null);
                    } finally {
                      setCreatingGoal(false);
                    }
                  }}
                />
              ) : (
                <div className="mt-2 flex flex-wrap items-start gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => setGoalStepIndex(index)}
                    data-tour="r-step-goal"
                  >
                    <Target className="mr-1 h-3.5 w-3.5" /> Set a goal for this step
                  </Button>
                  <StepPlaylistSuggestions step={step} categoryName={categoryName} />
                </div>
              )}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
