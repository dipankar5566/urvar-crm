"use client";

import { MapContainer, TileLayer, Marker, Circle, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

// Leaflet's default marker icon hardcodes relative image paths that break
// under every bundler — override with explicit ESM asset URLs instead.
// Turbopack resolves these node_modules image imports to plain URL strings
// rather than the { src } object Next's webpack-oriented types describe, so
// handle both shapes.
function resolveAssetUrl(asset: string | { src: string }): string {
  return typeof asset === "string" ? asset : asset.src;
}

delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: resolveAssetUrl(markerIcon2x),
  iconUrl: resolveAssetUrl(markerIcon),
  shadowUrl: resolveAssetUrl(markerShadow),
});

const INDIA_CENTER: [number, number] = [20.5937, 78.9629];
const INDIA_DEFAULT_ZOOM = 5;
const PINNED_ZOOM = 15;

export type Pin = { lat: number; lng: number; accuracy?: number };

function ClickHandler({ onChange }: { onChange: (latlng: Pin) => void }) {
  useMapEvents({
    click(e) {
      // A manual click/drag always means a precise, deliberate placement —
      // drop any previous GPS accuracy circle so it doesn't apply here.
      onChange({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

export default function LocationMap({
  value,
  onChange,
}: {
  value: Pin | null;
  onChange: (latlng: Pin) => void;
}) {
  return (
    <MapContainer
      center={value ?? INDIA_CENTER}
      zoom={value ? PINNED_ZOOM : INDIA_DEFAULT_ZOOM}
      className="h-full w-full"
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      />
      <ClickHandler onChange={onChange} />
      {value && value.accuracy && (
        <Circle
          center={value}
          radius={value.accuracy}
          pathOptions={{ color: "#2563eb", fillOpacity: 0.1, weight: 1 }}
        />
      )}
      {value && (
        <Marker
          position={value}
          draggable
          eventHandlers={{
            dragend: (e) => {
              const marker = e.target as L.Marker;
              const pos = marker.getLatLng();
              onChange({ lat: pos.lat, lng: pos.lng });
            },
          }}
        />
      )}
    </MapContainer>
  );
}
