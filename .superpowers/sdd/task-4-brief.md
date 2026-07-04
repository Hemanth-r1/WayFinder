# Task 4: Toast notification system

**Files:**
- Create: `src/components/Toast.tsx`

## Requirements

Create a toast notification system with two exports:
1. `pushToast(text: string, type: 'info'|'success'|'warning'|'error', duration?: number)` — global function to queue a toast
2. `ToastContainer` — default export React component that renders the toast stack

The system uses a simple module-level array + listener pattern (no React context needed):

```typescript
import { useState, useEffect, useCallback } from 'react';

export interface ToastMessage {
  id: string;
  text: string;
  type: 'info' | 'success' | 'warning' | 'error';
  duration?: number;
}

let toastId = 0;
let listeners: Array<(msgs: ToastMessage[]) => void> = [];
let messages: ToastMessage[] = [];

function notify() {
  for (const fn of listeners) fn([...messages]);
}

export function pushToast(text: string, type: ToastMessage['type'] = 'info', duration = 4000) {
  const id = `toast-${++toastId}`;
  messages = [...messages, { id, text, type, duration }];
  notify();
  if (duration > 0) {
    setTimeout(() => {
      messages = messages.filter(m => m.id !== id);
      notify();
    }, duration);
  }
}

export default function ToastContainer() {
  const [items, setItems] = useState<ToastMessage[]>([]);

  useEffect(() => {
    listeners.push(setItems);
    return () => { listeners = listeners.filter(fn => fn !== setItems); };
  }, []);

  const dismiss = useCallback((id: string) => {
    messages = messages.filter(m => m.id !== id);
    notify();
  }, []);

  const bgColor: Record<string, string> = {
    info: '#4488FF', success: '#4CAF50', warning: '#FF9800', error: '#f44336',
  };

  return (
    <div style={{
      position: 'fixed', bottom: 80, left: 12, zIndex: 9999,
      display: 'flex', flexDirection: 'column', gap: 6, pointerEvents: 'none',
    }}>
      {items.map(msg => (
        <div
          key={msg.id}
          onClick={() => dismiss(msg.id)}
          style={{
            background: bgColor[msg.type], color: '#fff', padding: '8px 14px',
            borderRadius: 6, fontSize: 12, fontFamily: 'monospace',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)', cursor: 'pointer',
            pointerEvents: 'auto', maxWidth: 320,
            animation: 'toastIn 0.25s ease-out',
          }}
        >
          {msg.text}
        </div>
      ))}
      <style>{`@keyframes toastIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  );
}
```

## Global Constraints
- `verbatimModuleSyntax: true` — use `import type` for type-only imports
- `erasableSyntaxOnly: true`
- `noUnusedLocals` / `noUnusedParameters` are errors
- Inline styles only

Run `npm run build` and `npm run lint` after creating the file.
