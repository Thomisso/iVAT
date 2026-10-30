"use client";

import { useEffect } from "react";
import { markUploadBatchNotificationReadAction } from "@/app/actions";

/** Marks the User's notification for this batch read once its processing has finished. */
export function MarkBatchNotificationRead({ batchId, finished }: { batchId: string; finished: boolean }) {
  useEffect(() => {
    if (finished) void markUploadBatchNotificationReadAction(batchId);
  }, [batchId, finished]);
  return null;
}
