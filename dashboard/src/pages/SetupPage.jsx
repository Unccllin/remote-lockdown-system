import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Lock, User, Eye, EyeOff, AlertCircle, CheckCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { setupApi } from '../api/setup';

export default function SetupPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ username: 'admin', password: '', confirmPassword: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(true);
  const [errors, setErrors] = useState({});

  // Check if setup is actually needed
  useEffect(() => {
    setupApi
      .getStatus()
      .then(({ data }) => {
        setNeedsSetup(data.needsSetup);
        setChecking(false);
        if (!data.needsSetup) {
          // Already set up — redirect to login
          navigate('/login', { replace: true });
        }
      })
      .catch(() => {
        setChecking(false);
        // If we can't check, assume setup is needed
      });
  }, [navigate]);

  function validate() {
    const errs = {};
    if (!form.username || form.username.length < 3) {
      errs.username = 'Username must be at least 3 characters';
    } else if (!/^[a-zA-Z0-9_-]+$/.test(form.username)) {
      errs.username = 'Only letters, numbers, underscores, and hyphens';
    }
    if (!form.password || form.password.length < 8) {
      errs.password = 'Password must be at least 8 characters';
    }
    if (form.password !== form.confirmPassword) {
      errs.confirmPassword = 'Passwords do not match';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    try {
      await setupApi.createAdmin(form.username, form.password);
      toast.success('Admin account created! Please log in.');
      navigate('/login', { replace: true });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Setup failed');
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <div className="text-slate-400 text-sm animate-pulse">Checking system status...</div>
      </div>
    );
  }

  if (!needsSetup) {
    return null; // Will redirect via useEffect
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 mb-4">
            <Shield className="text-indigo-400" size={32} />
          </div>
          <h1 className="text-2xl font-bold text-slate-100">Initial Setup</h1>
          <p className="text-slate-400 text-sm mt-2">
            Create the administrator account for your Remote Lockdown System.
          </p>
        </div>

        {/* Security notice */}
        <div className="card mb-6 border-amber-500/20 bg-amber-950/20">
          <div className="flex gap-3">
            <AlertCircle className="text-amber-400 shrink-0 mt-0.5" size={18} />
            <div className="text-sm text-amber-200/80">
              <p className="font-medium text-amber-300 mb-1">First-time setup</p>
              <p>This screen only appears once. After creating the admin account, this endpoint is permanently disabled for security.</p>
            </div>
          </div>
        </div>

        {/* Setup form */}
        <form onSubmit={handleSubmit} className="card space-y-5">
          {/* Username */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              <User size={12} className="inline mr-1" />
              Admin Username
            </label>
            <input
              className={`input font-mono ${errors.username ? 'border-red-500/50' : ''}`}
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="admin"
              required
              autoComplete="username"
            />
            {errors.username && (
              <p className="text-xs text-red-400 mt-1">{errors.username}</p>
            )}
          </div>

          {/* Password */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              <Lock size={12} className="inline mr-1" />
              Password
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                className={`input pr-10 ${errors.password ? 'border-red-500/50' : ''}`}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="At least 8 characters"
                required
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {errors.password && (
              <p className="text-xs text-red-400 mt-1">{errors.password}</p>
            )}
          </div>

          {/* Confirm Password */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              <Lock size={12} className="inline mr-1" />
              Confirm Password
            </label>
            <input
              type={showPassword ? 'text' : 'password'}
              className={`input ${errors.confirmPassword ? 'border-red-500/50' : ''}`}
              value={form.confirmPassword}
              onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
              placeholder="Re-enter password"
              required
              autoComplete="new-password"
            />
            {errors.confirmPassword && (
              <p className="text-xs text-red-400 mt-1">{errors.confirmPassword}</p>
            )}
          </div>

          {/* Submit */}
          <button className="btn-primary w-full" type="submit" disabled={loading}>
            {loading ? 'Creating account...' : 'Create Admin Account'}
          </button>
        </form>

        {/* Footer */}
        <div className="text-center mt-6">
          <p className="text-xs text-slate-500">
            <CheckCircle size={12} className="inline mr-1 text-emerald-500" />
            Security keys are generated automatically and stored locally.
          </p>
        </div>
      </div>
    </div>
  );
}
