"use client";

import * as React from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { parseSubtitleText, isSubtitleFileName } from "@/lib/subtitleParse";
import { toast } from "sonner";

/**
 * Phase 4 (roadmap v3) — lets a learner provide a transcript for any video
 * that has no official captions (anything that isn't YouTube today).
 * Reuses the same textarea + save-button pattern as the Notes tab
 * (src/app/video/[videoId]/page.tsx's "notes" TabsContent) rather than
 * inventing a new input style.
 *
 * Once saved, this transcript becomes the grounding source for that
 * video's AI summary and quiz (see src/lib/ai/universalTranscript.ts).
 */
export function TranscriptInput({
  value,
  onChange,
  onSave,
  saving,
  textareaRef,
}: {
  value: string;
  onChange: (text: string) => void;
  onSave: () => void;
  saving?: boolean;
  textareaRef?: React.RefObject<HTMLTextAreaElement>;
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!isSubtitleFileName(file.name)) {
      toast.error("Only .srt or .vtt files are supported.");
      return;
    }
    try {
      const raw = await file.text();
      const parsed = parseSubtitleText(raw);
      if (!parsed) {
        toast.error("Couldn't find any text in that file.");
        return;
      }
      onChange(parsed);
      toast.success("Transcript loaded from file — review it, then save.");
    } catch {
      toast.error("Couldn't read that file.");
    }
  }

  return (
    <div className="space-y-3">
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste this video's transcript here, or upload an .srt/.vtt file below…"
        className="min-h-[160px]"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onSave} size="sm" loading={saving} loadingText="Saving…">
          {value.trim() ? "Save transcript" : "Clear transcript"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="h-4 w-4" />
          Upload .srt/.vtt
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".srt,.vtt"
          className="hidden"
          onChange={handleFileSelected}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Paste or upload a transcript to unlock AI summaries and quizzes grounded in the actual
        content — private to you.
      </p>
    </div>
  );
}
