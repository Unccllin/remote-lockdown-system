import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api/client';

export default function EnrollPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ hostname: '', owner_name: '' });
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.post('/devices', form);
      toast.success(`Device "${data.hostname}" enrolled successfully`);
      navigate(`/devices/${data.id}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Enrollment failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-lg">
      <button onClick={() => navigate('/devices')} className="flex items-center gap-2 text-slate-400 hover:text-slate-200 text-sm mb-6">
        <ArrowLeft size={14} /> Back to Devices
      </button>

      <h1 className="text-2xl font-bold text-slate-100 mb-1">Enroll a Device</h1>
      <p className="text-slate-400 text-sm mb-6">Register a new device in the system. The agent must be configured with this hostname.</p>

      <form onSubmit={handleSubmit} className="card space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Hostname</label>
          <input
            className="input font-mono"
            value={form.hostname}
            onChange={(e) => setForm({ ...form, hostname: e.target.value })}
            placeholder="e.g. AGENT-LAPTOP-001"
            required
          />
          <p className="text-xs text-slate-500 mt-1">Must match exactly what the agent reports.</p>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Owner Name</label>
          <input
            className="input"
            value={form.owner_name}
            onChange={(e) => setForm({ ...form, owner_name: e.target.value })}
            placeholder="e.g. John Doe"
            required
          />
        </div>
        <button className="btn-primary" type="submit" disabled={loading}>
          {loading ? 'Enrolling…' : 'Enroll Device'}
        </button>
      </form>
    </div>
  );
}
