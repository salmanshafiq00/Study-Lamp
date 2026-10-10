"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth/AuthProvider";
import { applyGoogleSync, getGoogleSyncStatus, GoogleApiError, isAmbiguousConnectionError, planGoogleSync, type GoogleSyncPlanResponse } from "@/lib/googleClient";
import { countActionableItems, isAutoCheckDue, readCalendarFlag, readLastAutoCheck, readSyncConnectionId, writeCalendarFlag, writeLastAutoCheck, writeSyncConnectionId } from "@/lib/googleCalendarFlag";
import { describeApplyOutcome, describeResultCode, summarizeApplyResults } from "@/lib/syncMessages";
import type { ConfirmApplyPayload } from "@/components/sync/ConfirmChangesDialog";

export interface CalendarSyncOutcome {
  tone: "success" | "warning" | "error";
  message: string;
  /** One plain sentence per item that was not applied. */
  details: string[];
  at: number;
}

export interface UseCalendarSyncOptions {
  /** Called after changes were really applied, so the page can reload its goals. */
  onApplied?: () => void;
  /** One read-only check on mount, at most every 10 minutes. */
  autoCheck?: boolean;
  /** Settings page: use this connection and skip the cached flag. */
  connectionId?: string;
  enabledOverride?: boolean;
}

export interface CalendarSyncController {
  enabled: boolean;
  plan: GoogleSyncPlanResponse | null;
  checking: boolean;
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  /** Number of changes ready (attention items excluded). */
  bannerCount: number;
  lastOutcome: CalendarSyncOutcome | null;
  /**
   * True when the server said several Google connections have Calendar sync on and the user must keep it on for just one
   * (audit M2). Without this the goals page would silently do nothing.
   */
  connectionProblem: boolean;
  /** After a goal was added/edited/completed: a read-only look at that one goal. */
  checkGoal: (goalId: string) => Promise<void>;
  /** Read-only check of everything. `openDialog` shows the review; `announceEmpty` says so when nothing is waiting. */
  checkAll: (options?: { force?: boolean; openDialog?: boolean; announceEmpty?: boolean }) => Promise<GoogleSyncPlanResponse | null>;
  apply: (payload: ConfirmApplyPayload) => Promise<void>;
}

/**
 * Client controller for Calendar sync. Everything here that talks to the server is either a READ-ONLY plan
 * or an apply that carries the signed plan token from the dialog the user just confirmed. Nothing in this
 * hook can write on its own.
 */
export function useCalendarSync(options: UseCalendarSyncOptions = {}): CalendarSyncController {
  const { user } = useAuth();
  const { onApplied, autoCheck = false, connectionId, enabledOverride } = options;
  const [enabled, setEnabled] = useState<boolean>(enabledOverride ?? false);
  const [plan, setPlan] = useState<GoogleSyncPlanResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<CalendarSyncOutcome | null>(null);
  const [connectionProblem, setConnectionProblem] = useState(false);
  const enabledRef = useRef(enabled);
  const planRef = useRef<GoogleSyncPlanResponse | null>(null);
  const onAppliedRef = useRef(onApplied);
  onAppliedRef.current = onApplied;
  planRef.current = plan;

  const uid = user?.uid ?? null;

  /** The settings page names its connection; the goals page uses the one learned from the status call (audit M2). */
  const currentConnectionId = useCallback((): string | undefined => {
    if (connectionId) return connectionId;
    return uid ? readSyncConnectionId(uid, "calendar") ?? undefined : undefined;
  }, [connectionId, uid]);

  /** A failed read-only check: remember "several connections" for the banner; forget a cached id the server no longer knows. */
  const noteCheckError = useCallback((error: unknown) => {
    if (isAmbiguousConnectionError(error)) {
      setConnectionProblem(true);
      return;
    }
    if (!connectionId && uid && error instanceof GoogleApiError && error.status === 404) writeSyncConnectionId(uid, "calendar", null);
  }, [connectionId, uid]);

  const setEnabledBoth = useCallback((value: boolean) => {
    enabledRef.current = value;
    setEnabled(value);
  }, []);

  useEffect(() => {
    if (enabledOverride !== undefined) setEnabledBoth(enabledOverride);
  }, [enabledOverride, setEnabledBoth]);

  const checkAll = useCallback<CalendarSyncController["checkAll"]>(async ({ force = false, openDialog = false, announceEmpty = false } = {}) => {
    if (!user || !enabledRef.current) return null;
    if (!force && !isAutoCheckDue(readLastAutoCheck(user.uid), Date.now())) return null;
    setChecking(true);
    try {
      const idToken = await user.getIdToken();
      const result = await planGoogleSync(idToken, undefined, currentConnectionId());
      writeLastAutoCheck(user.uid, Date.now());
      setConnectionProblem(false);
      setPlan(result);
      if (openDialog && result.items.length > 0) setDialogOpen(true);
      if (announceEmpty && result.items.length === 0) toast.success("Study Lamp and Google Calendar are in step. Nothing to change.");
      return result;
    } catch (error) {
      noteCheckError(error);
      // A background check must stay quiet (the banner covers "several connections"); an explicit one says what went wrong.
      if (force || openDialog || announceEmpty) toast.error(error instanceof Error && error.message ? error.message : "Couldn't check Google Calendar.");
      return null;
    } finally {
      setChecking(false);
    }
  }, [user, currentConnectionId, noteCheckError]);

  // Learn whether Calendar sync is on (cached flag first; one cheap status call when unknown), then maybe check once.
  useEffect(() => {
    if (!user || enabledOverride !== undefined) return;
    let cancelled = false;
    (async () => {
      let flag = readCalendarFlag(user.uid);
      if (flag === null) {
        try {
          const status = await getGoogleSyncStatus(await user.getIdToken(), currentConnectionId());
          flag = status.enabled;
          writeCalendarFlag(user.uid, flag);
          if (flag && status.connectionId) writeSyncConnectionId(user.uid, "calendar", status.connectionId);
        } catch (error) {
          // Several connections with Calendar on: tell the user instead of quietly doing nothing (audit M2).
          if (isAmbiguousConnectionError(error)) setConnectionProblem(true);
          flag = false;
        }
      }
      if (cancelled) return;
      setEnabledBoth(flag);
      if (flag && autoCheck) void checkAll();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  const checkGoal = useCallback(async (goalId: string) => {
    if (!user || !enabledRef.current) return;
    try {
      const idToken = await user.getIdToken();
      const result = await planGoogleSync(idToken, [goalId], currentConnectionId());
      setConnectionProblem(false);
      const ready = countActionableItems(result.items);
      if (ready === 0) return;
      setPlan(result);
      toast(`Google Calendar: ${ready} change${ready === 1 ? "" : "s"} ready to review`, {
        action: { label: "Review", onClick: () => setDialogOpen(true) },
        duration: 10_000,
      });
    } catch (error) {
      // The goal was saved either way. "Several connections" shows as a banner; other problems are in Settings > Google.
      noteCheckError(error);
    }
  }, [user, currentConnectionId, noteCheckError]);

  const apply = useCallback(async (payload: ConfirmApplyPayload) => {
    const current = planRef.current;
    if (!user || !current) throw new Error("There is nothing to apply. Check again.");
    const idToken = await user.getIdToken();
    // A thrown error (expired token, already applied, Google unreachable) is shown inside the dialog.
    const response = await applyGoogleSync(idToken, { planToken: current.planToken, ...payload, ...(currentConnectionId() ? { connectionId: currentConnectionId() } : {}) });
    const tally = summarizeApplyResults(response.results);
    const outcome = describeApplyOutcome(tally);
    const details = response.results
      .filter((result) => result.status !== "applied" && result.code !== "not_accepted")
      .map((result) => describeResultCode(result.code))
      .filter((text, index, all) => text && all.indexOf(text) === index);
    setLastOutcome({ ...outcome, details, at: Date.now() });
    if (outcome.tone === "success") toast.success(outcome.message);
    else if (outcome.tone === "warning") toast.warning(outcome.message);
    else toast.error(outcome.message);
    if (tally.applied > 0) onAppliedRef.current?.();
    setPlan(null);
    void checkAll({ force: true });
  }, [user, currentConnectionId, checkAll]);

  return {
    enabled,
    plan,
    checking,
    dialogOpen,
    setDialogOpen,
    bannerCount: plan ? countActionableItems(plan.items) : 0,
    lastOutcome,
    connectionProblem,
    checkGoal,
    checkAll,
    apply,
  };
}
