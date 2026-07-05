import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';

export default function ConfirmModal({ title, description, confirmLabel, confirmValue, onConfirm, onCancel, danger = true }) {
  const [typed, setTyped] = useState('');
  const needsMatch = !!confirmValue;
  const canConfirm = needsMatch ? typed === confirmValue : true;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <div className="flex items-start gap-4 mb-4">
          <div className={`p-2 rounded-lg ${danger ? 'bg-red-900/50' : 'bg-blue-900/50'}`}>
            <AlertTriangle size={20} className={danger ? 'text-red-400' : 'text-blue-400'} />
          </div>
          <div>
            <h3 className="font-semibold text-slate-100 text-base">{title}</h3>
            <p className="text-slate-400 text-sm mt-1">{description}</p>
          </div>
        </div>

        {needsMatch && (
          <div className="mb-4">
            <label className="text-xs text-slate-400 mb-1 block">
              Type <span className="font-mono text-slate-200 font-bold">{confirmValue}</span> to confirm
            </label>
            <input
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={confirmValue}
              autoFocus
            />
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button
            className={danger ? 'btn-danger' : 'btn-primary'}
            disabled={!canConfirm}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
