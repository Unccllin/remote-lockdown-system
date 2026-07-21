import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldAlert, Loader, Lock, User } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api/client';
import { setupApi } from '../api/setup';

export default function LoginPage() {
  const [form, setForm] = useState({ username: '', password: '' });
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  // Check if setup is needed (no admin exists yet) — redirect to setup
  useEffect(() => {
    setupApi
      .getStatus()
      .then(({ data }) => {
        if (data.needsSetup) {
          navigate('/setup', { replace: true });
        }
      })
      .catch(() => {
        // If we can't check, continue to login
      });
  }, [navigate]);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', form);
      localStorage.setItem('token', data.token);
      navigate('/');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden">
      {/* Background glow */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-cyan-600/10 rounded-full blur-3xl" />

      <div className="w-full max-w-sm relative animate-fade-in">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8 gap-4">
          <div className="relative">
            <div className="absolute inset-0 bg-blue-500/30 blur-2xl rounded-3xl" />
            <div className="relative bg-gradient-to-br from-blue-500 to-blue-700 p-4 rounded-3xl shadow-lg shadow-blue-600/30">
              <ShieldAlert size={36} className="text-white" />
            </div>
          </div>
          <div className="text-center">
            <h1 className="text-xl font-bold text-slate-100">DeviceLock Admin</h1>
            <p className="text-slate-400 text-sm mt-1">Remote Device Lockdown System</p>
          </div>
        </div>

        {/* Login form */}
        <form onSubmit={handleSubmit} className="card space-y-5">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Username</label>
            <div className="relative">
              <User size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                className="input pl-10"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder="admin"
                required
                autoFocus
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Password</label>
            <div className="relative">
              <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                className="input pl-10"
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="••••••••"
                required
              />
            </div>
          </div>
          <button className="btn-primary w-full justify-center" type="submit" disabled={loading}>
            {loading ? <Loader size={16} className="animate-spin" /> : <ShieldAlert size={16} />}
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="text-center text-xs text-slate-600 mt-6">
          Authorized personnel only. All actions are logged.
        </p>
      </div>
    </div>
  );
}
