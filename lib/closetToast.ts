/** One-shot toast message consumed when Closet tab gains focus after add flow. */
let queued: string | null = null;

export function queueClosetToast(message: string) {
  queued = message;
}

export function takeClosetToast(): string | null {
  const t = queued;
  queued = null;
  return t;
}
