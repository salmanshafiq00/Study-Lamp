import { NextResponse } from "next/server";
import { GoogleConnectionError } from "@/lib/server/googleConnections";
import { GoogleCalendarApiError } from "@/lib/server/googleCalendar";
import { CalendarListTruncatedError } from "@/lib/server/goalSyncPlan";
import { GoogleTasksApiError } from "@/lib/server/googleTasks";
import { TasksListTruncatedError } from "@/lib/server/tasksSyncPlan";
import { logServerError } from "@/lib/server/logError";

/** Maps known failures to fixed, generic messages. Library and Google messages are never returned. */
export function syncErrorResponse(label: string, error: unknown): NextResponse {
  if (error instanceof GoogleConnectionError) {
    const status = error.code === "not_found" ? 404 : error.code === "network" ? 502 : 409;
    const messages: Record<GoogleConnectionError["code"], string> = {
      not_found: "Google connection not found.",
      invalid: "This Google connection needs to be reconnected.",
      network: "Couldn't reach Google. Please try again shortly.",
      scope_missing: "This Google connection does not have the needed Google access.",
      calendar_deleted: "The Study Lamp calendar was deleted in Google. Turn Calendar sync on again to create a new one.",
      tasks_list_deleted: "The Study Lamp task list was deleted in Google. Turn Tasks sync on again to create a new one.",
      ambiguous: "More than one Google connection has this sync turned on. Open Settings > Google and keep it on for just one.",
    };
    // `code` lets the browser show the "choose one connection" banner instead of a silent no-op (audit M2).
    return NextResponse.json({ error: messages[error.code], ...(error.code === "ambiguous" ? { code: "ambiguous" } : {}) }, { status });
  }
  if (error instanceof CalendarListTruncatedError) {
    return NextResponse.json({ error: "The Study Lamp calendar has too many events to compare safely." }, { status: 409 });
  }
  if (error instanceof TasksListTruncatedError) {
    return NextResponse.json({ error: "The Study Lamp task list has too many tasks to compare safely." }, { status: 409 });
  }
  if (error instanceof GoogleTasksApiError) {
    logServerError(label, error);
    if (error.kind === "remote_missing") {
      return NextResponse.json({ error: "The Study Lamp task list was not found in Google." }, { status: 409 });
    }
    return NextResponse.json({ error: "Google Tasks could not be reached. Please try again shortly." }, { status: 502 });
  }
  if (error instanceof GoogleCalendarApiError) {
    logServerError(label, error);
    if (error.kind === "remote_missing") {
      return NextResponse.json({ error: "The Study Lamp calendar was not found in Google." }, { status: 409 });
    }
    return NextResponse.json({ error: "Google Calendar could not be reached. Please try again shortly." }, { status: 502 });
  }
  logServerError(label, error);
  return NextResponse.json({ error: "Couldn't complete the sync request." }, { status: 500 });
}
