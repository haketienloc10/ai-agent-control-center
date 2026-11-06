import type { AgentSession, ContextPacket, Delivery, Message, WorkspaceConfig } from "@aacc/contracts";
import { CoordinationStore } from "./coordination-store.js";
import type { AgentRuntime } from "./codex-runtime.js";
import { defaultInstructionsDir, roleInstructions } from "./instructions.js";

const discoveryEnabled = (config: WorkspaceConfig) =>
  Boolean(config.discovery && config.discovery.enabled !== false);

/** Role rules come from `instructions/<role>.md` (optional); code only appends this session's data. */
function withData(rules: string | undefined, data: string[]): string {
  return [...(rules ? [rules] : []), ...data].join("\n\n");
}
const modulesData = (config: WorkspaceConfig) =>
  "MODULES: " + JSON.stringify(config.modules.map(m => ({ id: m.id, label: m.label, path: m.path })));
function leadInstructions(config: WorkspaceConfig, dir: string): string {
  return withData(roleInstructions(dir, "lead"), [
    "LEAD_WORKSPACE: " + config.lead.cwd,
    modulesData(config),
    "DISCOVERY_ENABLED: " + discoveryEnabled(config)
  ]);
}
/** Chỉ dữ liệu động của lượt này. */
function leadPrompt(store: CoordinationStore, delivery: Delivery): string {
  const events = store.leadInputs(delivery.id);
  const peers = store.agentSessions(delivery.conversationId, "peer").map(s => ({
    moduleId: s.moduleId, sessionId: s.id, status: s.status, error: s.error
  }));
  const discovery = store.agentSessions(delivery.conversationId, "discovery").map(s => ({
    sessionId: s.id, status: s.status, error: s.error
  }));
  return [
    "PEER_SESSIONS: " + JSON.stringify(peers),
    "DISCOVERY_SESSIONS: " + JSON.stringify(discovery),
    "NEW_EVENTS: " + JSON.stringify(events.map(m => ({
      id: m.id, from: m.from, to: m.to, peerSessionId: m.peerSessionId,
      discoverySessionId: m.discoverySessionId, text: m.text
    })))
  ].join("\n\n");
}
/** Each Worker receives only this handoff delta, never a shared Lead/other-agent Thread. */
function packetParts(packet: ContextPacket): string[] {
  const inThread = "(đã gửi ở lượt trước trong Thread này; dùng nội dung đó)";
  return [
    "ORIGINAL_USER_REQUEST: " + (packet.originalRequest ? JSON.stringify(packet.originalRequest) : inThread),
    "TASK_BRIEF_FROM_LEAD: " + (packet.taskBrief ? JSON.stringify(packet.taskBrief)
      : packet.omitted?.taskBrief ? "(không đổi so với lượt trước trong Thread này)" : "null"),
    "SUPPORTING_CONTEXT: " + JSON.stringify(packet.sources),
    ...(packet.omitted?.sourceIds?.length
      ? ["SOURCES_ALREADY_IN_THREAD: " + JSON.stringify(packet.omitted.sourceIds)] : []),
    ...(packet.decisions?.length
      ? ["DECISIONS_FROM_LEAD: " + JSON.stringify(packet.decisions)] : []),
    ...(packet.omitted?.decisionIds?.length
      ? ["DECISIONS_ALREADY_IN_THREAD: " + JSON.stringify(packet.omitted.decisionIds)] : []),
    "LEAD_EXPECTED_RESULT: " + packet.expectedResult
  ];
}
function workerPacket(message: Message): ContextPacket {
  if (!message.contextPacket) throw new Error("Worker delivery thiếu Context Packet");
  return message.contextPacket;
}
function discoveryInstructions(config: WorkspaceConfig, dir: string): string {
  return withData(roleInstructions(dir, "discovery"), [modulesData(config)]);
}
function discoveryPrompt(message: Message): string {
  return [...packetParts(workerPacket(message)), "LEAD_MESSAGE: " + message.text].join("\n\n");
}
function peerInstructions(config: WorkspaceConfig, session: AgentSession, dir: string): string {
  return withData(roleInstructions(dir, "peer"), [
    "MODULE: " + session.moduleId,
    "WORKSPACE MODULE: " + config.modules.find(m => m.id === session.moduleId)?.path
  ]);
}
function peerPrompt(message: Message): string {
  const packet = workerPacket(message);
  const checkpoint = packet.peerCheckpoint;
  // Giữ nguyên packet cũ đã queued; không tái tạo context bằng trạng thái mới hơn.
  if (!checkpoint) return [...packetParts(packet), "LEAD_MESSAGE: " + message.text].join("\n\n");
  const list = (items: string[], empty: string) => items.length
    ? items.map(item => "- " + item.replaceAll("\n", "\n  ")).join("\n") : empty;
  return [
    "ASSIGNMENT: " + checkpoint.assignmentId,
    "MODULE: " + checkpoint.moduleId,
    ...(checkpoint.continues ? ["CONTINUES: " + checkpoint.continues] : []),
    ...(packet.originalRequest ? ["ORIGINAL_USER_REQUEST:\n" + packet.originalRequest.text] : []),
    "CURRENT_GOAL:\n" + checkpoint.goal,
    "ACCEPTANCE_CRITERIA:\n" + list(checkpoint.acceptanceCriteria, "Lead chưa cung cấp tiêu chí hoàn thành."),
    "CURRENT_CONSTRAINTS:\n" + list(checkpoint.constraints, "Không có ràng buộc bổ sung do Lead cung cấp."),
    "ACTIVE_DECISIONS:\n" + list((packet.decisions ?? []).map(d =>
      d.id + " · " + d.topic + "\n" + d.decision +
      (d.evidenceRefs.length ? "\nCăn cứ: " + d.evidenceRefs.join(", ") : "")),
      "Không có quyết định áp dụng cho module trong assignment này."),
    "PREVIOUS_CONTEXT:\n" + list((packet.previousContext ?? []).map(source =>
      source.messageId + " · " + source.kind + " · " + source.from + " · " + source.createdAt +
      "\n" + (source.summary ?? "Nội dung đã có trong Thread; Lead không cung cấp tóm tắt.")), "Không có nguồn cũ được chọn."),
    "NEW_SUPPORTING_CONTEXT:\n" + (packet.sources.length ? packet.sources.map(source =>
      source.messageId + " · " + source.kind + " · " + source.from + " · " + source.createdAt + "\n" + source.text
    ).join("\n\n") : "Không có nguồn mới."),
    "WORK:\n" + message.text,
    "EXPECTED_RESULT:\n" + packet.expectedResult
  ].join("\n\n");
}

/** Queued event deliveries wake idle sessions; no Lead polling turn is scheduled. */
export class Coordinator {
  private readonly active = new Set<string>();
  private scheduled = false;
  constructor(private readonly config: WorkspaceConfig, private readonly store: CoordinationStore,
    private readonly runtime: AgentRuntime, private readonly concurrency = 4,
    private readonly instructionsDir = defaultInstructionsDir) {
    store.on("change", () => this.schedule());
    this.schedule();
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }
  private pump() {
    for (const delivery of this.store.queued()) {
      if (this.active.size >= this.concurrency) break;
      if (this.active.has(delivery.sessionId)) continue;
      const session = this.store.session(delivery.sessionId);
      if (!session || session.status === "running") continue;
      this.active.add(session.id);
      try { this.store.startDelivery(delivery.id); }
      catch { this.active.delete(session.id); continue; }
      void this.execute(delivery.id).finally(() => {
        this.active.delete(session.id);
        this.schedule();
      });
    }
  }
  private async execute(deliveryId: string) {
    try {
      const delivery = this.store.delivery(deliveryId)!;
      const session = this.store.session(delivery.sessionId)!;
      const input = this.store.input(delivery.id)!;
      const cwd = session.role === "lead" ? this.config.lead.cwd :
        session.role === "discovery" ? this.config.discovery?.cwd :
        this.config.modules.find(m => m.id === session.moduleId)?.path;
      if (!cwd) throw new Error("Module không còn trong cấu hình: " + session.moduleId);
      const prompt = session.role === "lead"
        ? leadPrompt(this.store, delivery)
        : session.role === "discovery" ? discoveryPrompt(input) : peerPrompt(input);
      const dir = this.instructionsDir;
      const instructions = session.role === "lead" ? leadInstructions(this.config, dir)
        : session.role === "discovery" ? discoveryInstructions(this.config, dir)
        : peerInstructions(this.config, session, dir);
      let finished = false;
      const hooks = {
        onThread: (threadId: string) => this.store.setThread(session.id, threadId),
        onTurn: (turnId: string) => this.store.setTurn(session.id, turnId),
        ...(session.role === "lead" ? { onLeadTool: (callId: string,
          command: import("@aacc/contracts").LeadCommand) => {
          const result = this.store.routeLeadTool(
            delivery.id, callId, command, this.config.modules.map(m => m.id),
            discoveryEnabled(this.config));
          if (command.type === "finish") finished = true;
          return result;
        } } : {})
      };
      const selection = session.role === "lead"
        ? this.store.settings().lead
        : session.role === "discovery"
          ? this.store.settings().discovery
          : { model: session.model, effort: session.effort };
      const workspaceRoots = session.role === "discovery"
        ? [...new Set([cwd, ...this.config.modules.map(m => m.path)])]
        : undefined;
      const output = await this.runtime.run(session, cwd, prompt, hooks, selection, workspaceRoots, instructions);
      if (session.role === "lead") {
        // finish() only updates task state; the final Codex response is persisted once.
        this.store.completeLead(delivery.id, output, finished);
      } else if (session.role === "discovery") {
        this.store.completeDiscovery(delivery.id, output);
      } else {
        this.store.completePeer(delivery.id, output);
      }
    } catch (error) {
      this.store.failDelivery(deliveryId, error instanceof Error ? error.message : String(error));
    }
  }
}
