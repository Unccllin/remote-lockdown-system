import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldAlert, Loader } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api/client';

export default function LoginPage() {
  const [form, setForm] = useState({ username: '', password: '' });
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', form);
      localStorage.setItem('token', data.token);
      navigate('/devices');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8 gap-3">
          <div className="bg-blue-600 p-3 rounded-2xl">
            <ShieldAlert size={32} className="text-white" />
          </div>
          <h1 className="text-xl font-bold text-slate-100">DeviceLock Admin</h1>
          <p className="text-slate-400 text-sm text-center">Remote Device Lockdown System</p>
        </div>

        <form onSubmit={handleSubmit} className="card space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Username</label>
            <input
              className="input"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              required
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Password</label>
            <input
              className="input"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
            />
          </div>
          <button className="btn-primary w-full justify-center" type="submit" disabled={loading}>
            {loading ? <Loader size={16} className="animate-spin" /> : null}
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
