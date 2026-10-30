import { useState } from "react";

export function ArtifactViewer({ id, label = "Xem bản vá Git" }: { id: string; label?: string }) {
  const [preview, setPreview] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function load() {
    if (preview !== undefined) { setPreview(undefined); return; }
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/artifacts/" + encodeURIComponent(id));
      if (!response.ok) throw new Error("Không đọc được artifact: HTTP " + response.status);
      const text = await response.text();
      setPreview(text.length > 100000 ? text.slice(0, 100000) + "\n…(truncated preview)" : text);
    } catch (cause) { setError(String(cause)); }
    finally { setLoading(false); }
  }
  return <div className="artifact-viewer">
    <button type="button" disabled={loading} onClick={() => void load()}>
      {loading ? "Đang đọc…" : preview === undefined ? label : "Đóng diff"}
    </button>
    <a href={"/api/artifacts/" + encodeURIComponent(id)}>Tải artifact</a>
    {error && <p className="error-text">{error}</p>}
    {preview !== undefined && <pre className="artifact-diff">{preview}</pre>}
  </div>;
}
