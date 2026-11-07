interface SnapshotEvents {
  addEventListener(type: string, listener: () => void): void;
  close(): void;
}

/** Gộp invalidation; không trì hoãn tải bằng timer và không bỏ snapshot đã nhận. */
export function createSnapshotSync<T>(options: {
  events: SnapshotEvents;
  load: () => Promise<T>;
  onData: (data: T) => void;
  onError: (cause: unknown) => void;
  onConnection: (state: "connected" | "offline") => void;
}) {
  let dirty = false;
  let disposed = false;
  let running: Promise<void> | undefined;
  let waiting: Array<() => void> = [];

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    dirty = true;
    // Mỗi caller chỉ chờ request bắt đầu sau invalidation của mình.
    const completion = new Promise<void>(resolve => waiting.push(resolve));
    if (!running) {
      running = Promise.resolve().then(async () => {
        try {
          while (dirty && !disposed) {
            dirty = false;
            const covered = waiting;
            waiting = [];
            try {
              const data = await options.load();
              if (!disposed) options.onData(data);
            } catch (cause) {
              if (!disposed) options.onError(cause);
            } finally {
              covered.forEach(resolve => resolve());
            }
          }
        } finally {
          running = undefined;
        }
      });
    }
    return completion;
  }

  options.events.addEventListener("open", () => {
    if (!disposed) options.onConnection("connected");
  });
  // Backend gửi connected khi mở SSE, kể cả reconnect: tải một lần qua message.
  options.events.addEventListener("message", () => { void refresh(); });
  options.events.addEventListener("error", () => {
    if (!disposed) options.onConnection("offline");
  });

  return {
    refresh,
    dispose() {
      disposed = true;
      dirty = false;
      waiting.forEach(resolve => resolve());
      waiting = [];
      options.events.close();
    }
  };
}
