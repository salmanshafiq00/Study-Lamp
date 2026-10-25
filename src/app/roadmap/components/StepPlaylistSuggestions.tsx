"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { buildPlaylistSearchQuery } from "@/lib/roadmapUtils";
import { searchPlaylistsForStep, type YouTubePlaylistSearchResult } from "@/lib/roadmapPlaylistClient";
import type { RoadmapStep } from "@/types";
import { Youtube } from "lucide-react";
import { toast } from "sonner";

/**
 * "Suggested playlists" for a single roadmap step.
 *
 * Extracted so the read-only view and the editor show the exact same option.
 * Suggestions are loaded on demand (one YouTube search per click) rather than
 * eagerly for every step, which keeps a 10-step roadmap from firing 10
 * searches the moment it opens.
 */
export function StepPlaylistSuggestions({
  step,
  categoryName,
  onPlaylistAdded,
}: {
  step: RoadmapStep;
  categoryName: string;
  onPlaylistAdded?: (playlist: { id: string; title: string }) => void;
}) {
  const { user } = useAuth();
  const [results, setResults] = React.useState<YouTubePlaylistSearchResult[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  async function load() {
    if (!user || loading) return;
    setOpen(true);
    setLoading(true);
    try {
      const idToken = await user.getIdToken();
      const query = buildPlaylistSearchQuery(step.title, categoryName);
      const next = await searchPlaylistsForStep(idToken, query, 5);
      setResults(next);
      if (next.length === 0) toast.info("No playlist suggestions found for this step.");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to search for playlists right now.");
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        onClick={() => (open && results ? setOpen(false) : void load())}
        disabled={loading}
      >
        <Youtube className="mr-1 h-3.5 w-3.5" />
        {loading ? "Searching…" : "Suggested playlists"}
      </Button>

      {open && results && results.length > 0 && (
        <div className="grid gap-2 pt-1 sm:grid-cols-2">
          {results.map((result) => (
            <div key={result.playlistId} className="flex gap-2 rounded-md border border-border bg-muted/40 p-2">
              {result.thumbnailUrl && (
                <div className="relative h-12 w-20 shrink-0 overflow-hidden rounded">
                  <Image src={result.thumbnailUrl} alt={result.title} fill className="object-cover" sizes="80px" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{result.title}</p>
                <p className="truncate text-[11px] text-muted-foreground">{result.channelTitle}</p>
                <Link
                  href={`/playlists/import?url=${encodeURIComponent(result.playlistUrl)}`}
                  className="mt-1 inline-block text-[11px] font-medium text-accent hover:underline"
                  onClick={() => onPlaylistAdded?.({ id: result.playlistId, title: result.title })}
                >
                  Add to my Playlists
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
