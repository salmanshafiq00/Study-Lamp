"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { DisconnectGoogleDialog } from "@/components/sync/DisconnectGoogleDialog";
import { SyncCleanupCard } from "@/components/sync/SyncCleanupCard";
import { SyncHistoryCard } from "@/components/sync/SyncHistoryCard";
import { DriveCard } from "@/components/google/DriveCard";
import { CalendarCard } from "@/components/google/CalendarCard";
import { TasksCard } from "@/components/google/TasksCard";
import { useGoogleWorkspace } from "@/components/google/useGoogleWorkspace";
import { cardFromLocation, GOOGLE_RETURN_PARAMS, messagesFromParams, type GoogleCardId } from "@/lib/googleSettings";
import { toast } from "sonner";

export default function GoogleSettingsPage() {
  return (
    <RequireAuth>
      <GoogleSettingsContent />
    </RequireAuth>
  );
}

function GoogleSettingsContent() {
  const searchParams = useSearchParams();
  const workspace = useGoogleWorkspace();
  const [activeCard, setActiveCard] = React.useState<GoogleCardId | null>(null);
  const scrolled = React.useRef(false);

  // The OAuth callbacks redirect back here with ?connected=<email>, ?error, ?missing=<feature> and ?tab=<card>.
  // Show the message once and pick the card to scroll to, then drop the parameters so a refresh doesn't repeat it.
  React.useEffect(() => {
    const messages = messagesFromParams(searchParams);
    for (const message of messages) {
      if (message.kind === "success") toast.success(message.text);
      else toast.error(message.text);
    }
    const card = cardFromLocation(searchParams.get("tab"), window.location.hash);
    if (card) setActiveCard(card);
    if (GOOGLE_RETURN_PARAMS.some((name) => searchParams.has(name))) {
      const url = new URL(window.location.href);
      for (const name of GOOGLE_RETURN_PARAMS) url.searchParams.delete(name);
      window.history.replaceState({}, "", url.toString());
    }
  }, [searchParams]);

  // Cards exist from the first render (with skeletons), so scroll once the Calendar/Tasks list has loaded.
  React.useEffect(() => {
    if (!activeCard || workspace.loading || scrolled.current) return;
    scrolled.current = true;
    document.getElementById(activeCard)?.scrollIntoView({ behavior: "smooth", block: "start" });
    const timer = window.setTimeout(() => setActiveCard(null), 4000);
    return () => window.clearTimeout(timer);
  }, [activeCard, workspace.loading]);

  const syncConnections = workspace.connections.filter((connection) => connection.grantedScopes.length > 0);

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold">Google</h1>
          <p className="text-sm text-muted-foreground">
            Study Lamp uses your Google account for Drive, Calendar and Tasks. Connect only what you need.
          </p>
        </div>

        <DriveCard highlight={activeCard === "drive"} />
        <CalendarCard workspace={workspace} highlight={activeCard === "calendar"} />
        <TasksCard workspace={workspace} highlight={activeCard === "tasks"} />

        {!workspace.loading && syncConnections.map((connection) => (
          <SyncCleanupCard key={connection.id} connection={connection} onChanged={workspace.load} />
        ))}

        {!workspace.loading && workspace.connections.length > 0 && <SyncHistoryCard />}
      </div>

      <DisconnectGoogleDialog
        connection={workspace.disconnectTarget}
        onOpenChange={(open) => { if (!open) workspace.setDisconnectTarget(null); }}
        onDisconnected={workspace.handleDisconnected}
      />
    </AppShell>
  );
}
