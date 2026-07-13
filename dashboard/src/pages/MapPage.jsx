import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup, Circle } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import api from '../api/client';
import toast from 'react-hot-toast';
import { MapPin, RefreshCw, Crosshair, ShieldOff, Wifi, Loader, WifiOff } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

const STATUS_COLORS = {
  active: '#10b981',
  stolen: '#ef4444',
  locked: '#f97316',
  tracking: '#06b6d4',
  recovering: '#f59e0b',
  inactive: '#64748b',
};

const STATUS_BADGE = {
  active: 'badge-active',
  stolen: 'badge-stolen',
  locked: 'badge-locked',
  recovering: 'badge-recovering',
  tracking: 'badge-tracking',
  inactive: 'badge-inactive',
};

const STATUS_ICON = {
  active: <Wifi size={11} />,
  stolen: <ShieldOff size={11} />,
  locked: <ShieldOff size={11} />,
  recovering: <Loader size={11} className="animate-spin" />,
  tracking: <Crosshair size={11} />,
  inactive: <WifiOff size={11} />,
};

function makeIcon(status) {
  const color = STATUS_COLORS[status] || STATUS_COLORS.inactive;
  const pulse = status === 'tracking'
    ? `<div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.5;animation:marker-pulse 1.6s ease-out infinite;"></div>`
    : '';
  const html = `
    <div style="position:relative;width:16px;height:16px;">
      ${pulse}
      <div style="position:absolute;inset:2px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,0.6);"></div>
    </div>
  `;
  return L.divIcon({
    html,
    className: 'custom-marker',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

export default function MapPage() {
  const navigate = useNavigate();
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get('/devices');
      const devices = Array.isArray(data) ? data : [];
      const located = [];
      await Promise.all(
        devices.map(async (d) => {
          try {
            const { data: locs } = await api.get(`/devices/${d.id}/locations?limit=1`);
            const latest = Array.isArray(locs) && locs[0];
            if (latest && latest.latitude != null && latest.longitude != null) {
              located.push({ device: d, location: latest });
            }
          } catch {
            // ignore devices with no location data
          }
        })
      );
      setPoints(located);
    } catch {
      toast.error('Failed to load map data');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const counts = points.reduce((acc, p) => {
    const s = p.device.status || 'inactive';
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  const legendItems = Object.entries(STATUS_COLORS).map(([status, color]) => ({
    status,
    color,
    count: counts[status] || 0,
  }));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Device Map</h1>
          <p className="text-slate-400 text-sm mt-1">
            {points.length} device{points.length === 1 ? '' : 's'} with location data
          </p>
        </div>
        <button className="btn-ghost" onClick={load}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="card p-0 overflow-hidden">
          <div className="h-[calc(100vh-200px)] w-full bg-slate-800/40 animate-pulse rounded-xl" />
        </div>
      ) : points.length === 0 ? (
        <div className="card text-center text-slate-500 py-32">
          <MapPin size={32} className="mx-auto mb-2 opacity-30" />
          <p className="text-slate-400">No devices with location data available.</p>
          <p className="text-slate-500 text-xs mt-1">
            Location pings will appear on the map once devices report their coordinates.
          </p>
        </div>
      ) : (
        <>
          <div className="card p-0 overflow-hidden mb-4">
            <MapContainer
              center={[20, 0]}
              zoom={2}
              scrollWheelZoom={true}
              style={{ height: '100%', width: '100%' }}
              className="h-[calc(100vh-200px)] rounded-xl"
            >
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution="&copy; OpenStreetMap contributors"
              />
              {points.map(({ device, location }) => {
                const color = STATUS_COLORS[device.status] || STATUS_COLORS.inactive;
                const icon = makeIcon(device.status);
                const pos = [location.latitude, location.longitude];
                return (
                  <Marker key={device.id} position={pos} icon={icon}>
                    <Popup>
                      <div style={{ minWidth: 200 }}>
                        <div style={{ fontWeight: 700, marginBottom: 4 }}>
                          {device.hostname}
                        </div>
                        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>
                          {device.owner_name}
                        </div>
                        <div style={{ marginBottom: 6 }}>
                          <span className={STATUS_BADGE[device.status] || 'badge-inactive'}>
                            {STATUS_ICON[device.status]}
                            {device.status}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: '#475569', marginBottom: 2 }}>
                          {location.latitude?.toFixed(4)}, {location.longitude?.toFixed(4)}
                        </div>
                        {(location.city || location.region || location.country) && (
                          <div style={{ fontSize: 12, color: '#475569', marginBottom: 2 }}>
                            {[location.city, location.region, location.country].filter(Boolean).join(', ')}
                          </div>
                        )}
                        <div style={{ fontSize: 12, color: '#475569', marginBottom: 6 }}>
                          {location.reported_at
                            ? formatDistanceToNow(new Date(location.reported_at), { addSuffix: true })
                            : 'Unknown time'}
                        </div>
                        <button
                          onClick={() => navigate(`/devices/${device.id}`)}
                          style={{
                            fontSize: 12,
                            color: '#38bdf8',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: 0,
                            textDecoration: 'underline',
                          }}
                        >
                          View device details →
                        </button>
                      </div>
                    </Popup>
                    {location.accuracy_meters && (
                      <Circle
                        center={pos}
                        radius={location.accuracy_meters}
                        pathOptions={{
                          color,
                          fillColor: color,
                          fillOpacity: 0.12,
                          weight: 1,
                        }}
                      />
                    )}
                  </Marker>
                );
              })}
            </MapContainer>
          </div>

          <div className="card flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="text-xs text-slate-400 uppercase tracking-wide">Legend</span>
            {legendItems.map(({ status, color, count }) => (
              <div key={status} className="flex items-center gap-2">
                <span
                  style={{ background: color }}
                  className="w-3 h-3 rounded-full border border-white/40 inline-block"
                />
                <span className="text-xs text-slate-300 capitalize">{status}</span>
                <span className="text-xs text-slate-500 font-mono">({count})</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
