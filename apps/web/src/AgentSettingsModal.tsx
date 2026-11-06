import { useEffect, useState } from "react";
import type { AppSettings, CodexModelOption, ModelSelection } from "@aacc/contracts";

const defaults: AppSettings = { lead: {}, peer: {}, discovery: {} };

export function AgentSettingsModal({ initial, onClose, onSaved }: {
  initial: AppSettings; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<AppSettings>(() => structuredClone(initial ?? defaults));
  const [models, setModels] = useState<CodexModelOption[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void fetch("/api/models", { cache: "no-store" })
      .then(async response => {
        const body = await response.json() as { models?: CodexModelOption[]; error?: string };
        if (!response.ok) throw new Error(body.error || "Không lấy được model/list");
        if (live) setModels(body.models ?? []);
      }).catch(reason => {
        if (live) setCatalogError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { live = false; };
  }, []);
  const patch = (role: "lead" | "peer" | "discovery", key: "model" | "effort", value: string) => {
    setSaved(false);
    setDraft(previous => ({
      ...previous,
      [role]: { ...previous[role], [key]: value }
    }));
  };
  const modelForm = (role: "lead" | "peer" | "discovery", title: string, description: string) => {
    const selection: ModelSelection = draft[role] ?? {};
    const selectedModel = models.find(m => m.id === selection.model);
    const efforts = selectedModel?.supportedReasoningEfforts ?? [];
    return <fieldset className="settings-role" key={role}>
      <legend>{title}</legend>
      <p>{description}</p>
      <label htmlFor={role + "-model"}>Model</label>
      <input id={role + "-model"} list="codex-models" value={selection.model ?? ""}
        autoComplete="off"
        placeholder="Để trống = mặc định Codex"
        onChange={event => patch(role, "model", event.target.value)}/>
      <label htmlFor={role + "-effort"}>Reasoning effort</label>
      <input id={role + "-effort"} list={role + "-effort-choices"}
        value={selection.effort ?? ""} autoComplete="off"
        placeholder="Để trống = mặc định Codex"
        onChange={event => patch(role, "effort", event.target.value)}/>
      <datalist id={role + "-effort-choices"}>
        {efforts.map(effort => <option key={effort} value={effort}/>)}
      </datalist>
      {selectedModel && <small>
        {selectedModel.displayName} · Effort hỗ trợ: {efforts.length ? efforts.join(", ") : "Codex quyết định"}
        {selectedModel.defaultReasoningEffort
          ? " · Mặc định: " + selectedModel.defaultReasoningEffort : ""}
      </small>}
    </fieldset>;
  };
  const save = async () => {
    if (saving) return;
    setSaving(true); setError(""); setSaved(false);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft)
      });
      const data = await response.json() as AppSettings & { error?: string };
      if (!response.ok) throw new Error(data.error || "Không lưu được App Settings");
      setDraft(data);
      await onSaved();
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  };
  return <div className="modal-backdrop" role="presentation">
    <section className="modal settings-modal" role="dialog" aria-modal="true" aria-label="App Settings">
      <div className="section-header">
        <h2>App Settings · Model &amp; Effort</h2>
        <button type="button" onClick={onClose}>Đóng</button>
      </div>
      <p className="settings-intro">Giá trị để trống kế thừa cấu hình Codex. Lead được phép override model và effort khi tạo Peer.</p>
      {catalogError
        ? <p className="settings-note" role="status">Không tải được model/list: {catalogError}. Bạn vẫn có thể nhập model thủ công.</p>
        : <p className="settings-note">Danh sách model lấy từ Codex app-server đang chạy trên máy này.</p>}
      <datalist id="codex-models">
        {models.map(m => <option key={m.id} value={m.id} label={m.displayName}/>)}
      </datalist>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        {modelForm("lead", "Lead Agent", "Áp dụng cho các lượt Lead tiếp theo, kể cả Thread hiện tại.")}
        {modelForm("discovery", "Discovery Agent", "Áp dụng cho các Discovery turn tiếp theo. Để trống kế thừa Codex default.")}
        {modelForm("peer", "Peer Agents", "Áp dụng khi Lead tạo Peer session mới. Peer đang tồn tại giữ cấu hình đã chọn.")}
        {error && <p role="alert" className="settings-error">{error}</p>}
        {saved && <p role="status" className="settings-saved">Đã lưu App Settings vào SQLite.</p>}
        <div className="settings-actions">
          <button type="button" onClick={() => setDraft({ lead: {}, peer: {}, discovery: {} })}>Dùng mặc định Codex</button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Đang lưu…" : "Lưu Settings"}
          </button>
        </div>
      </form>
    </section>
  </div>;
}
