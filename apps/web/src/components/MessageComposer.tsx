export function MessageComposer({ value, onChange, onSend, sending }: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
}) {
  return <form className="composer" onSubmit={e => { e.preventDefault(); onSend(); }}>
    <label htmlFor="message-input" className="sr-only">Nhắn Lead</label>
    <textarea id="message-input" value={value} rows={2} onChange={e => onChange(e.target.value)}
      placeholder="Nhắn Lead: giao thêm việc, xác nhận kết quả, giải quyết vấn đề…"
      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault(); onSend();
      } }}/>
    <div className="composer-footer">
      <span>Enter gửi · Shift+Enter xuống dòng</span>
      <button type="submit" className="primary" disabled={sending || !value.trim()}>
        {sending ? "Đang gửi…" : "Gửi Lead"} <span aria-hidden="true">↗</span>
      </button>
    </div>
  </form>;
}
