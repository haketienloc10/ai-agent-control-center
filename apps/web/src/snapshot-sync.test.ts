import assert from "node:assert/strict";
import { test } from "node:test";
import { createSnapshotSync } from "./snapshot-sync.js";

class FakeEvents extends EventTarget {
  closed = false;
  close() { this.closed = true; }
  send(type: "open" | "message" | "error") { this.dispatchEvent(new Event(type)); }
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
  const events = new FakeEvents();
  const requests: Array<{ resolve: (data: number) => void; reject: (cause: Error) => void }> = [];
  const data: number[] = [];
  const errors: unknown[] = [];
  const connections: string[] = [];
  let active = 0;
  let peak = 0;
  const sync = createSnapshotSync({
    events,
    load: () => {
      active++;
      peak = Math.max(peak, active);
      return new Promise<number>((resolve, reject) => {
        requests.push({
          resolve: value => { active--; resolve(value); },
          reject: cause => { active--; reject(cause); }
        });
      });
    },
    onData: value => data.push(value),
    onError: cause => errors.push(cause),
    onConnection: state => connections.push(state)
  });
  return { events, requests, data, errors, connections, sync, peak: () => peak };
}

test("Burst SSE và refresh trực tiếp chỉ tạo một request đang chạy, rồi tải bù", async () => {
  const f = fixture();
  f.events.send("message");
  await flush();
  for (let i = 0; i < 20; i++) f.events.send("message");
  let completed = false;
  const waiting = f.sync.refresh().then(() => { completed = true; });
  assert.equal(f.requests.length, 1);

  f.requests[0].resolve(1);
  await flush();
  assert.deepEqual(f.data, [1], "Hiển thị response hiện tại dù có event mới");
  assert.equal(f.requests.length, 2);
  assert.equal(completed, false, "Caller chờ cả lần tải bù");

  // Event đến trong lần tải bù cũng phải được xử lý.
  f.events.send("message");
  f.requests[1].resolve(2);
  await flush();
  assert.deepEqual(f.data, [1, 2]);
  await waiting;
  assert.equal(completed, true, "Caller hoàn tất dù event tiếp tục cần tải bù");
  assert.equal(f.requests.length, 3);
  f.requests[2].resolve(3);
  await flush();
  assert.deepEqual(f.data, [1, 2, 3]);
  assert.equal(f.peak(), 1);
  assert.equal(completed, true);
  await flush();
  assert.equal(f.requests.length, 3, "Không polling sau khi hết event");
  f.sync.dispose();
});

test("connected tải lần đầu và sau reconnect, open không tạo request trùng", async () => {
  const f = fixture();
  assert.equal(f.requests.length, 0);
  f.events.send("open");
  // Message connected của backend đi cùng sự kiện open.
  f.events.send("message");
  await flush();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve(1);
  await flush();
  assert.equal(f.requests.length, 1);

  f.events.send("error");
  f.events.send("open");
  f.events.send("message");
  await flush();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(2);
  await flush();
  assert.deepEqual(f.data, [1, 2], "Tự đồng bộ thay đổi trong lúc ngắt kết nối");
  assert.deepEqual(f.connections, ["connected", "offline", "connected"]);
  f.sync.dispose();
});

test("Lỗi giữ dữ liệu cũ, không tự lặp request và cho phép Thử lại", async () => {
  const f = fixture();
  const first = f.sync.refresh();
  await flush();
  f.requests[0].resolve(1);
  await first;

  const failed = f.sync.refresh();
  await flush();
  const cause = new Error("HTTP 503");
  f.requests[1].reject(cause);
  await failed;
  await flush();
  assert.deepEqual(f.data, [1]);
  assert.deepEqual(f.errors, [cause]);
  assert.equal(f.requests.length, 2);

  const retry = f.sync.refresh();
  await flush();
  f.requests[2].resolve(2);
  await retry;
  assert.deepEqual(f.data, [1, 2]);
  f.sync.dispose();
});

test("Event đến khi request lỗi vẫn kích hoạt tải bù", async () => {
  const f = fixture();
  void f.sync.refresh();
  await flush();
  const waiting = f.sync.refresh();
  f.requests[0].reject(new Error("HTTP 503"));
  await flush();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(2);
  await waiting;
  assert.deepEqual(f.data, [2]);
  assert.equal(f.peak(), 1);
  f.sync.dispose();
});

test("Unmount đóng SSE, bỏ response muộn và không tải bù", async () => {
  for (const fail of [false, true]) {
    const f = fixture();
    const waiting = f.sync.refresh();
    await flush();
    f.events.send("message");
    f.sync.dispose();
    if (fail) f.requests[0].reject(new Error("Late failure"));
    else f.requests[0].resolve(1);
    await waiting;
    f.events.send("open");
    f.events.send("message");
    f.events.send("error");
    await f.sync.refresh();
    assert.equal(f.events.closed, true);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.data, []);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.connections, []);
  }
});
