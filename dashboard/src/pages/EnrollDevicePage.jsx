import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, KeyRound, Copy, Check, QrCode, Clock, Loader,
  CheckCircle2, RefreshCw, Terminal, Download, Monitor,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api/client';

/**
 * Derive the server base URL (no /api suffix) for the install command.
 * The api client's baseURL is one of:
 *   - window.electronApp.apiBaseUrl (Worker URL in serverless/Electron mode)
 *   - import.meta.env.VITE_API_URL
 *   - '/api' (same-origin Express server)
 * We strip a trailing '/api' so the command points at the server root.
 */
function getServerBaseUrl() {
  const electronApiUrl = typeof window !== 'undefined' && window.electronApp?.apiBaseUrl;
  const baseURL = electronApiUrl || import.meta.env.VITE_API_URL || '/api';
  // Strip trailing /api to get the server root URL
  if (baseURL.endsWith('/api')) {
    return baseURL.slice(0, -4);
  }
  // Same-origin '/api' → use the current origin
  if (baseURL === '/api') {
    return window.location.origin;
  }
  return baseURL;
}

/**
 * EnrollDevicePage — streamlined device enrollment via enrollment tokens.
 *
 * Flow:
 *   1. Admin clicks "Generate Enrollment Token"
 *   2. Dashboard calls POST /api/enroll/token → gets a 15-minute token
 *   3. Admin runs a single command on the target machine:
 *        lockdown-installer.exe --token TOKEN --server-url https://...
 *   4. The installer calls POST /api/enroll/claim with the token
 *   5. This page polls GET /api/devices every 5s; when a new device
 *      appears, it shows a success message and navigates to the device list
 */
export default function EnrollDevicePage() {
  const navigate = useNavigate();
  const [token, setToken] = useState(null);
  const [expiresAt, setExpiresAt] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [polling, setPolling] = useState(false);
  const [success, setSuccess] = useState(null); // new device object
  const initialDeviceIds = useRef(new Set());
  const pollTimer = useRef(null);

  const serverBaseUrl = getServerBaseUrl();

  // Countdown timer — ticks every second while a token is active
  useEffect(() => {
    if (!expiresAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  // Stop polling when the component unmounts
  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const remainingMs = expiresAt ? expiresAt - now : 0;
  const expired = remainingMs <= 0;
  const remainingMin = Math.floor(Math.max(0, remainingMs) / 60000);
  const remainingSec = Math.floor((Math.max(0, remainingMs) % 60000) / 1000);

  const installCommand = token
    ? `lockdown-installer.exe --token ${token} --server-url ${serverBaseUrl}`
    : '';

  // QR code image URL — uses a lightweight public QR generation API.
  // The QR encodes the full install command so a mobile app can scan it.
  const qrUrl = token
    ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(installCommand)}`
    : '';

  async function generateToken() {
    setGenerating(true);
    setSuccess(null);
    try {
      const { data } = await api.post('/enroll/token');
      setToken(data.token);
      setExpiresAt(new Date(data.expires_at).getTime());
      setNow(Date.now());
      // Snapshot current device IDs so we can detect the new one
      try {
        const { data: devs } = await api.get('/devices');
        initialDeviceIds.current = new Set(
          (Array.isArray(devs) ? devs : []).map((d) => d.id),
        );
      } catch {
        // If we can't list devices, start with empty set — any new device counts
        initialDeviceIds.current = new Set();
      }
      startPolling();
      toast.success('Enrollment token generated — valid for 15 minutes');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to generate enrollment token');
    } finally {
      setGenerating(false);
    }
  }

  const pollForNewDevice = useCallback(async () => {
    try {
      const { data } = await api.get('/devices');
      const devs = Array.isArray(data) ? data : [];
      const newDevice = devs.find((d) => !initialDeviceIds.current.has(d.id));
      if (newDevice) {
        setSuccess(newDevice);
        setPolling(false);
        toast.success(`Device "${newDevice.hostname}" enrolled successfully!`);
        // Navigate to device list after a short delay so the user sees the success state
        setTimeout(() => navigate('/devices'), 2500);
        return;
      }
      // Keep polling if the token hasn't expired
      if (expiresAt && Date.now() < expiresAt) {
        pollTimer.current = setTimeout(pollForNewDevice, 5000);
      } else {
        setPolling(false);
      }
    } catch {
      // Network error — retry after 5s if still valid
      if (expiresAt && Date.now() < expiresAt) {
        pollTimer.current = setTimeout(pollForNewDevice, 5000);
      } else {
        setPolling(false);
      }
    }
  }, [expiresAt, navigate]);

  function startPolling() {
    setPolling(true);
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(pollForNewDevice, 5000);
  }

  function copyCommand() {
    navigator.clipboard.writeText(installCommand).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success('Command copied to clipboard');
    }).catch(() => {
      toast.error('Failed to copy command');
    });
  }

  // --- Success view ---
  if (success) {
    return (
      <div className="max-w-lg">
        <button
          onClick={() => navigate('/devices')}
          className="flex items-center gap-2 text-slate-400 hover:text-slate-200 text-sm mb-6"
        >
          <ArrowLeft size={14} /> Back to Devices
        </button>

        <div className="card text-center py-10">
          <CheckCircle2 size={48} className="mx-auto text-emerald-400 mb-4" />
          <h1 className="text-2xl font-bold text-slate-100 mb-2">Device Enrolled!</h1>
          <p className="text-slate-400 text-sm mb-4">
            <span className="font-mono text-slate-200">{success.hostname}</span> has been
            enrolled and is now active.
          </p>
          <p className="text-xs text-slate-500 mb-6">Redirecting to device list…</p>
          <button
            onClick={() => navigate('/devices')}
            className="btn-primary"
          >
            View Devices
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <button
        onClick={() => navigate('/devices')}
        className="flex items-center gap-2 text-slate-400 hover:text-slate-200 text-sm mb-6"
      >
        <ArrowLeft size={14} /> Back to Devices
      </button>

      <h1 className="text-2xl font-bold text-slate-100 mb-1">Enroll a Device</h1>
      <p className="text-slate-400 text-sm mb-6">
        Generate a short-lived enrollment token, then run a single command on the
        target machine. No admin password needed on the target.
      </p>

      {/* Generate token button (initial state) */}
      {!token && (
        <div className="card text-center py-10">
          <KeyRound size={40} className="mx-auto text-blue-400 mb-4" />
          <h2 className="text-lg font-semibold text-slate-200 mb-2">
            Generate Enrollment Token
          </h2>
          <p className="text-sm text-slate-400 mb-6 max-w-md mx-auto">
            The token is valid for 15 minutes and can be used once. After generating it,
            run the displayed command on the target device.
          </p>
          <button
            onClick={generateToken}
            disabled={generating}
            className="btn-primary"
          >
            {generating ? (
              <>
                <Loader size={14} className="animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <KeyRound size={14} />
                Generate Enrollment Token
              </>
            )}
          </button>
        </div>
      )}

      {/* Token display */}
      {token && (
        <div className="space-y-6">
          {/* Countdown / expiry banner */}
          <div className={`card flex items-center gap-3 ${expired ? 'border-red-500/30' : 'border-blue-500/20'}`}>
            <Clock size={18} className={expired ? 'text-red-400' : 'text-blue-400'} />
            <div className="flex-1">
              <p className="text-xs text-slate-400">Token {expired ? 'expired' : 'expires in'}</p>
              <p className={`text-sm font-mono font-bold ${expired ? 'text-red-400' : 'text-slate-200'}`}>
                {expired ? 'Expired — generate a new token' : `${remainingMin}m ${remainingSec.toString().padStart(2, '0')}s`}
              </p>
            </div>
            {expired && (
              <button onClick={generateToken} disabled={generating} className="btn-ghost text-xs">
                <RefreshCw size={12} className={generating ? 'animate-spin' : ''} />
                Regenerate
              </button>
            )}
          </div>

          {/* QR code + token */}
          <div className="card">
            <h3 className="text-sm font-medium text-slate-300 mb-4 flex items-center gap-2">
              <QrCode size={14} /> Scan or Copy Token
            </h3>
            <div className="flex flex-col sm:flex-row gap-6 items-center">
              {/* QR code */}
              <div className="shrink-0">
                <img
                  src={qrUrl}
                  alt="QR code for enrollment command"
                  width={200}
                  height={200}
                  className="rounded-lg bg-white p-2"
                  data-testid="enroll-qr-code"
                />
                <p className="text-xs text-slate-500 text-center mt-2">Scan to copy command</p>
              </div>

              {/* Token text */}
              <div className="flex-1 w-full">
                <p className="text-xs text-slate-400 mb-1">Enrollment Token</p>
                <code
                  className="block bg-slate-950/50 rounded-lg p-3 text-xs font-mono text-slate-300 break-all"
                  data-testid="enroll-token-display"
                >
                  {token}
                </code>
              </div>
            </div>
          </div>

          {/* Install command */}
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-slate-300 flex items-center gap-2">
                <Terminal size={14} /> Run on Target Device
              </h3>
              <button
                onClick={copyCommand}
                className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                data-testid="copy-command-btn"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? 'Copied!' : 'Copy Command'}
              </button>
            </div>
            <code
              className="block bg-slate-950/50 rounded-lg p-3 text-xs font-mono text-emerald-300 break-all"
              data-testid="enroll-command-display"
            >
              {installCommand}
            </code>
            <p className="text-xs text-slate-500 mt-3">
              Run this in an elevated PowerShell on the target Windows machine.
              The installer enrolls the device and installs the agent service automatically.
            </p>
          </div>

          {/* Download installer */}
          <div className="card border-emerald-700/30 bg-emerald-950/10">
            <h3 className="text-sm font-medium text-slate-300 mb-2 flex items-center gap-2">
              <Monitor size={14} className="text-emerald-400" />
              Download Setup Wizard (Recommended)
            </h3>
            <p className="text-xs text-slate-500 mb-4">
              Download a single .exe file with a GUI wizard. Just double-click on the
              target device, paste the enrollment token, and the wizard handles everything —
              no PowerShell or command line needed.
            </p>
            <div className="flex gap-3">
              <a
                href={`${serverBaseUrl}/api/download/installer`}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-emerald-900/30 hover:bg-emerald-900/50 border border-emerald-700/50 text-sm text-slate-200 transition-colors"
                data-testid="download-installer-btn"
              >
                <Download size={16} className="text-emerald-400" />
                Download Setup Wizard (.exe)
              </a>
              <a
                href={`${serverBaseUrl}/api/download/agent`}
                className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm text-slate-200 transition-colors"
                data-testid="download-agent-btn"
              >
                <Download size={16} className="text-indigo-400" />
                Agent Only
              </a>
            </div>
            <p className="text-xs text-slate-500 mt-3">
              The setup wizard downloads the agent automatically during installation.
              Only download "Agent Only" if you're using the command-line installer.
            </p>
          </div>

          {/* Waiting status */}
          {!expired && polling && (
            <div className="card flex items-center gap-3">
              <Loader size={18} className="text-blue-400 animate-spin" />
              <div>
                <p className="text-sm text-slate-200 font-medium">Waiting for device…</p>
                <p className="text-xs text-slate-500">
                  The device list updates automatically when enrollment completes.
                </p>
              </div>
            </div>
          )}

          {/* Expired notice */}
          {expired && (
            <div className="card border-red-500/20 bg-red-950/10">
              <p className="text-sm text-red-300">
                The enrollment token has expired. Generate a new token to continue.
              </p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={generateToken}
              disabled={generating}
              className="btn-secondary"
            >
              <RefreshCw size={14} className={generating ? 'animate-spin' : ''} />
              Generate New Token
            </button>
            <button
              onClick={() => navigate('/devices')}
              className="btn-ghost"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
