"use client";

import * as React from "react";
import { CalendarRange } from "lucide-react";
import { CalendarSyncCard } from "@/components/sync/CalendarSyncCard";
import { WorkspaceFeatureCard } from "./WorkspaceFeatureCard";
import type { GoogleWorkspaceState } from "./useGoogleWorkspace";

/** Google Calendar card on Settings → Google (from the old Google Workspace page). */
export function CalendarCard({ workspace, highlight }: { workspace: GoogleWorkspaceState; highlight?: boolean }) {
  return (
    <WorkspaceFeatureCard
      feature="calendar"
      icon={CalendarRange}
      title="Google Calendar"
      description="Keep your study goals in step with a calendar. Study Lamp reads to check for changes and writes only after you confirm."
      access="only the calendar Study Lamp creates. It never reads or edits your other calendars."
      highlight={highlight}
      workspace={workspace}
      renderSync={(connection) => <CalendarSyncCard connection={connection} onChanged={workspace.load} />}
    />
  );
}
