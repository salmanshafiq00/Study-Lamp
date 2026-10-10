"use client";

import * as React from "react";
import { ListTodo } from "lucide-react";
import { TasksSyncCard } from "@/components/sync/TasksSyncCard";
import { WorkspaceFeatureCard } from "./WorkspaceFeatureCard";
import type { GoogleWorkspaceState } from "./useGoogleWorkspace";

/** Google Tasks card on Settings → Google (from the old Google Workspace page). */
export function TasksCard({ workspace, highlight }: { workspace: GoogleWorkspaceState; highlight?: boolean }) {
  return (
    <WorkspaceFeatureCard
      feature="tasks"
      icon={ListTodo}
      title="Google Tasks"
      description="Keep your study goals in step with a task list. Study Lamp reads to check for changes and writes only after you confirm."
      access="ALL your task lists (Google offers no narrower Tasks permission). Study Lamp's own code limits itself to the “Study Lamp” list it creates and never reads or changes your other lists."
      highlight={highlight}
      workspace={workspace}
      renderSync={(connection) => <TasksSyncCard connection={connection} onChanged={workspace.load} />}
    />
  );
}
