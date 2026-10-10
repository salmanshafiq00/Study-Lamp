"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { FEATURE_LABELS, featureStatus } from "@/lib/googleSettings";
import type { GoogleConnectionSummary, GoogleWorkspaceFeature } from "@/types";
import type { GoogleWorkspaceState } from "./useGoogleWorkspace";

const STATUS_LABEL = { connected: "Connected", needs_reconnect: "Needs reconnect", not_connected: "Not connected" } as const;

/**
 * Shared layout of the Calendar and Tasks cards: status, "what Study Lamp can access", one row per connected
 * account that was granted this feature, and the feature's own sync card inside each row.
 */
export function WorkspaceFeatureCard({
  feature,
  icon: Icon,
  title,
  description,
  access,
  highlight = false,
  workspace,
  renderSync,
}: {
  feature: GoogleWorkspaceFeature;
  icon: LucideIcon;
  title: string;
  description: string;
  access: string;
  highlight?: boolean;
  workspace: GoogleWorkspaceState;
  renderSync: (connection: GoogleConnectionSummary) => React.ReactNode;
}) {
  const { connections, loading, connecting, busy, load, grant, reconnect, setDisconnectTarget } = workspace;
  const label = FEATURE_LABELS[feature];
  const status = featureStatus(connections, feature);
  const granted = connections.filter((connection) => connection.grantedScopes.includes(feature));

  return (
    <section id={feature} aria-label={title} className="scroll-mt-4">
      <Card className={cn(highlight && "ring-2 ring-accent")}>
        <CardContent className="space-y-4 p-4">
          <div className="flex items-start gap-2.5">
            <div className="rounded-md bg-accent/10 p-2">
              <Icon className="h-5 w-5 text-accent" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-base font-semibold">{title}</h2>
                {!loading && (
                  <Badge variant={status === "connected" ? "success" : status === "needs_reconnect" ? "destructive" : "secondary"}>
                    {STATUS_LABEL[status]}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{description}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">What Study Lamp can access:</span> {access}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {status !== "connected" && (
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => grant(feature, label)}
                disabled={busy || loading}
                loading={connecting === feature}
                loadingText="Redirecting…"
              >
                <Plus className="h-4 w-4" /> Allow {label} access
              </Button>
            )}
            <Button size="sm" variant="ghost" className="gap-1.5" onClick={load} disabled={busy || loading}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
          </div>

          {loading && (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
            </div>
          )}

          {!loading && granted.length === 0 && (
            <div className="space-y-1 rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              <p className="font-medium text-foreground">{label} is not connected yet</p>
              <p>Allow {label} access above to get started.</p>
            </div>
          )}

          {!loading && granted.map((connection) => (
            <div key={connection.id} className="space-y-3 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-medium">{connection.googleEmail}</span>
                    {connection.status === "invalid" ? (
                      <Badge variant="destructive">Needs reconnect</Badge>
                    ) : (
                      <Badge variant="success">Active</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {connection.lastUsedAt ? `Last used ${new Date(connection.lastUsedAt).toLocaleString()}` : "Not used yet"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {connection.status === "invalid" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => reconnect(connection)}
                      disabled={busy}
                      loading={connecting === "reconnect"}
                    >
                      <RefreshCw className="h-4 w-4" /> Reconnect
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDisconnectTarget(connection)}
                    aria-label={`Disconnect ${connection.googleEmail}`}
                    title="Disconnects this account from Calendar and Tasks"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {renderSync(connection)}
            </div>
          ))}

          {!loading && granted.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Disconnecting an account removes both its Calendar and Tasks access. Anything already in Google is left untouched.
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
