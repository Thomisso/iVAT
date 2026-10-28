export type CompanyExportPollingStatus = "pending" | "completed" | "failed" | "stale";
export type CompanyExportTerminalStatus = Exclude<CompanyExportPollingStatus, "pending">;

type PendingExportStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type PollPause = (signal: AbortSignal) => Promise<void>;

export const COMPANY_EXPORT_POLL_INTERVAL_MS = 500;

function storageKey(companyId: string): string {
  return `iVAT:pending-company-export:${companyId}`;
}

export function rememberPendingCompanyExport(
  storage: PendingExportStorage,
  companyId: string,
  exportId: string,
): void {
  storage.setItem(storageKey(companyId), exportId);
}

export function readPendingCompanyExport(
  storage: PendingExportStorage,
  companyId: string,
): string | null {
  return storage.getItem(storageKey(companyId));
}

export function forgetPendingCompanyExport(storage: PendingExportStorage, companyId: string): void {
  storage.removeItem(storageKey(companyId));
}

function pauseForNextPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, COMPANY_EXPORT_POLL_INTERVAL_MS);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Waits for a database-terminal export state; component lifecycle aborts are the only early exit. */
export async function pollCompanyExportStatus(
  readStatus: (signal: AbortSignal) => Promise<CompanyExportPollingStatus>,
  options: { signal: AbortSignal; pause?: PollPause },
): Promise<CompanyExportTerminalStatus> {
  const pause = options.pause ?? pauseForNextPoll;
  while (true) {
    options.signal.throwIfAborted();
    const status = await readStatus(options.signal);
    options.signal.throwIfAborted();
    if (status !== "pending") return status;
    await pause(options.signal);
  }
}
