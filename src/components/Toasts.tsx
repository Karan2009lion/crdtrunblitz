import { useStore } from '../store/useStore';
import { Icon } from './Icon';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-tone={t.tone}>
          <span>{t.message}</span>
          <button className="btn btn-sm btn-icon btn-ghost" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <Icon name="x" />
          </button>
        </div>
      ))}
    </div>
  );
}
