export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'ok' | 'error';
  action?: { label: string; run: () => void };
}
let next = 1;
class Toasts {
  list = $state<Toast[]>([]);
  show(message: string, opts: { tone?: Toast['tone']; action?: Toast['action']; ms?: number } = {}) {
    const t: Toast = { id: next++, message, tone: opts.tone ?? 'info', ...(opts.action ? { action: opts.action } : {}) };
    this.list = [...this.list, t];
    setTimeout(() => this.dismiss(t.id), opts.ms ?? (opts.action ? 7000 : 3500));
    return t.id;
  }
  dismiss(id: number) {
    this.list = this.list.filter((t) => t.id !== id);
  }
}
export const toasts = new Toasts();
