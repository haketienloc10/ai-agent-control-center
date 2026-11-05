export function NewTaskModal({ value, onChange, onClose, onSubmit, sending }: {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  sending: boolean;
}) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={e => {
    if (e.target === e.currentTarget) onClose();
  }}>
    <section className="modal new-task-modal" role="dialog" aria-modal="true" aria-labelledby="new-task-title">
      <div className="section-header">
        <div><h2 id="new-task-title">Yêu cầu mới cho Lead</h2>
          <p>Lead sẽ phân công Peer theo từng module và phản hồi khi có kết quả.</p></div>
        <button className="quiet-button" type="button" onClick={onClose}>Đóng</button>
      </div>
      <form onSubmit={e => { e.preventDefault(); onSubmit(); }}>
        <label htmlFor="new-request">Mô tả công việc</label>
        <textarea id="new-request" autoFocus rows={7} value={value} onChange={e => onChange(e.target.value)}
          placeholder="Ví dụ: Bổ sung chức năng lọc công việc cho ứng dụng Todo List…"/>
        <button className="primary full" type="submit" disabled={sending || !value.trim()}>
          {sending ? "Đang tạo…" : "Gửi Lead"}
        </button>
      </form>
    </section>
  </div>;
}
