"use client";

import * as React from "react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth/AuthProvider";
import { cacheSyncStateFromConnections } from "@/lib/googleCalendarFlag";
import { listGoogleConnections, startGoogleConnect } from "@/lib/googleClient";
import { errorMessage } from "@/lib/googleSettings";
import type { GoogleConnectionSummary, GoogleWorkspaceFeature } from "@/types";

/**
 * Calendar + Tasks connection state, shared by CalendarCard and TasksCard so the page makes ONE list call.
 * Logic moved unchanged from the old /settings/google page.
 */
export function useGoogleWorkspace() {
  const { user } = useAuth();
  const [connections, setConnections] = React.useState<GoogleConnectionSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [connecting, setConnecting] = React.useState<GoogleWorkspaceFeature | "reconnect" | null>(null);
  const [disconnectTarget, setDisconnectTarget] = React.useState<GoogleConnectionSummary | null>(null);

  const load = React.useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const idToken = await user.getIdToken();
      const list = await listGoogleConnections(idToken);
      setConnections(list);
      // Keep the cached "is Calendar / Tasks sync on, and for which connection?" state honest for the goals page.
      cacheSyncStateFromConnections(user.uid, list);
    } catch (error) {
      toast.error(errorMessage(error, "Failed to load your Google Calendar and Tasks connections."));
    } finally {
      setLoading(false);
    }
  }, [user]);

  React.useEffect(() => { load(); }, [load]);

  /** Starts the flow for exactly one feature so access is granted incrementally. */
  const grant = React.useCallback(async (feature: GoogleWorkspaceFeature, label: string) => {
    if (!user) return;
    setConnecting(feature);
    try {
      const idToken = await user.getIdToken();
      await startGoogleConnect(idToken, [feature]); // navigates away to Google
    } catch (error) {
      toast.error(errorMessage(error, `Failed to start connecting Google ${label}.`));
      setConnecting(null);
    }
  }, [user]);

  const reconnect = React.useCallback(async (connection: GoogleConnectionSummary) => {
    if (!user) return;
    // Re-request everything this connection already has so a single consent
    // fixes an "invalid" state without losing existing permissions.
    const features = connection.grantedScopes.length > 0 ? connection.grantedScopes : (["calendar"] as GoogleWorkspaceFeature[]);
    setConnecting("reconnect");
    try {
      const idToken = await user.getIdToken();
      await startGoogleConnect(idToken, features); // navigates away to Google
    } catch (error) {
      toast.error(errorMessage(error, "Failed to start reconnecting Google."));
      setConnecting(null);
    }
  }, [user]);

  /** Runs after the dialog finished (any optional removal first, then the disconnect itself). */
  const handleDisconnected = React.useCallback((connection: GoogleConnectionSummary, removed: number) => {
    if (!user) return;
    const remaining = connections.filter((c) => c.id !== connection.id);
    setConnections(remaining);
    cacheSyncStateFromConnections(user.uid, remaining);
    toast.success(removed > 0 ? `Removed ${removed} item${removed === 1 ? "" : "s"} from Google and disconnected.` : "Disconnected. Anything already in Google was left untouched.");
  }, [user, connections]);

  return {
    connections,
    loading,
    connecting,
    busy: connecting !== null,
    disconnectTarget,
    setDisconnectTarget,
    load,
    grant,
    reconnect,
    handleDisconnected,
  };
}

export type GoogleWorkspaceState = ReturnType<typeof useGoogleWorkspace>;
