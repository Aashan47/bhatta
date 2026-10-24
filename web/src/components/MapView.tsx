import { useEffect, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { usePrefs } from "../i18n";
import type { KilnListItem, Status } from "../types";
import { prefersReducedMotion } from "../lib/util";

const STYLE = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};
const EOX_TILES = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg";
const EOX_ATTR =
  '<a href="https://s2maps.eu" target="_blank" rel="noreferrer">Sentinel-2 cloudless by EOX IT Services GmbH</a> (contains modified Copernicus Sentinel data)';

const STATUSES: Status[] = ["ZIGZAG", "FCBK", "UNDETERMINED", "NOT_DETECTED"];
const VAR: Record<Status, string> = {
  ZIGZAG: "--zigzag",
  FCBK: "--fcbk",
  UNDETERMINED: "--undetermined",
  NOT_DETECTED: "--notseen",
};

/** Draw the same distinct shapes as StatusIcon onto a canvas so the map never relies on colour alone. */
function drawIcon(status: Status, color: string, ring: string): ImageData {
  const S = 44;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const g = c.getContext("2d")!;
  g.lineJoin = "round";
  g.lineCap = "round";
  const m = S / 2;
  g.fillStyle = color;
  g.strokeStyle = ring;
  g.lineWidth = 3;
  if (status === "ZIGZAG") {
    g.beginPath();
    g.arc(m, m, 17, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.strokeStyle = "#fff";
    g.lineWidth = 4.4;
    g.beginPath();
    g.moveTo(m - 8, m + 1);
    g.lineTo(m - 2.5, m + 6.5);
    g.lineTo(m + 8.5, m - 6);
    g.stroke();
  } else if (status === "FCBK") {
    g.beginPath();
    g.roundRect(m - 16, m - 16, 32, 32, 5);
    g.fill();
    g.stroke();
    g.fillStyle = "#fff";
    g.fillRect(m - 2.4, m - 10, 4.8, 12);
    g.beginPath();
    g.arc(m, m + 8.5, 2.8, 0, Math.PI * 2);
    g.fill();
  } else if (status === "UNDETERMINED") {
    g.beginPath();
    g.moveTo(m, m - 18);
    g.lineTo(m + 19, m + 15);
    g.lineTo(m - 19, m + 15);
    g.closePath();
    g.fill();
    g.stroke();
    g.fillStyle = "#fff";
    g.font = "bold 20px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("?", m, m + 4);
  } else {
    g.fillStyle = ring;
    g.beginPath();
    g.arc(m, m, 15, 0, Math.PI * 2);
    g.fill();
    g.setLineDash([6, 4.5]);
    g.strokeStyle = color;
    g.lineWidth = 4.5;
    g.beginPath();
    g.arc(m, m, 13, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = color;
    g.beginPath();
    g.arc(m, m, 3.4, 0, Math.PI * 2);
    g.fill();
  }
  return g.getImageData(0, 0, S, S);
}

function toGeoJSON(kilns: KilnListItem[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: kilns.map((k) => ({
      type: "Feature",
      id: k.id,
      properties: { id: k.id, status: k.status, sort: k.status === "FCBK" ? 3 : k.status === "UNDETERMINED" ? 2 : k.status === "ZIGZAG" ? 1 : 0 },
      geometry: { type: "Point", coordinates: [k.lon, k.lat] },
    })),
  };
}

/** Small square footprints around each kiln for the 3D columns. Height tracks p(FCBK) where known. */
function toColumns(kilns: KilnListItem[], pFcbk?: Map<string, number>): GeoJSON.FeatureCollection {
  const half = 260; // metres: wide enough to read at district zoom
  return {
    type: "FeatureCollection",
    features: kilns.map((k) => {
      const dLat = half / 111320;
      const dLon = half / (111320 * Math.cos((k.lat * Math.PI) / 180));
      const p = k.p_fcbk ?? pFcbk?.get(k.id);
      const h = k.status === "NOT_DETECTED" ? 500 : p == null ? 900 : 400 + p * 3200;
      return {
        type: "Feature",
        properties: { id: k.id, status: k.status, h },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [k.lon - dLon, k.lat - dLat],
              [k.lon + dLon, k.lat - dLat],
              [k.lon + dLon, k.lat + dLat],
              [k.lon - dLon, k.lat + dLat],
              [k.lon - dLon, k.lat - dLat],
            ],
          ],
        },
      };
    }),
  };
}

/** Tour stops: each district's centre, then the densest 0.1 degree cell of FCBK kilns. */
function tourStops(kilns: KilnListItem[]) {
  const by = new Map<string, { lat: number; lon: number; n: number }>();
  for (const k of kilns) {
    const d = by.get(k.district) ?? { lat: 0, lon: 0, n: 0 };
    d.lat += k.lat;
    d.lon += k.lon;
    d.n += 1;
    by.set(k.district, d);
  }
  const stops = [...by.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 6)
    .map(([name, d]) => ({ name, center: [d.lon / d.n, d.lat / d.n] as [number, number], zoom: 10 }));
  const cells = new Map<string, { lat: number; lon: number; n: number }>();
  for (const k of kilns) {
    if (k.status !== "FCBK") continue;
    const key = `${Math.floor(k.lat * 10)}:${Math.floor(k.lon * 10)}`;
    const c = cells.get(key) ?? { lat: 0, lon: 0, n: 0 };
    c.lat += k.lat;
    c.lon += k.lon;
    c.n += 1;
    cells.set(key, c);
  }
  const best = [...cells.values()].sort((a, b) => b.n - a.n)[0];
  if (best) stops.push({ name: "FCBK", center: [best.lon / best.n, best.lat / best.n], zoom: 11.6 });
  return stops;
}

function extent(kilns: KilnListItem[]): [number, number, number, number] | null {
  if (!kilns.length) return null;
  let w = 180, s = 90, e = -180, n = -90;
  for (const k of kilns) {
    w = Math.min(w, k.lon);
    e = Math.max(e, k.lon);
    s = Math.min(s, k.lat);
    n = Math.max(n, k.lat);
  }
  return [w, s, e, n];
}

export interface MapViewProps {
  kilns: KilnListItem[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  bbox?: [number, number, number, number];
  satellite?: boolean;
  className?: string;
  label: string;
  compact?: boolean;
  focus?: { lon: number; lat: number; zoom?: number };
  threeD?: boolean;
  /** p(FCBK) per kiln id, for column heights in 3D. */
  pFcbk?: Map<string, number>;
  tour?: boolean;
  onTourStop?: (name: string | null) => void;
}

export function MapView({ kilns, selectedId, onSelect, bbox, satellite = false, className = "", label, compact = false, focus, threeD = false, pFcbk, tour = false, onTourStop }: MapViewProps) {
  const { resolvedTheme, t } = usePrefs();
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const latest = useRef({ kilns, selectedId, satellite, onSelect, threeD, pFcbk, onTourStop });
  latest.current = { kilns, selectedId, satellite, onSelect, threeD, pFcbk, onTourStop };
  const [failed, setFailed] = useState(false);
  const fitted = useRef(false);

  // Create the map once.
  useEffect(() => {
    if (!el.current) return;
    let map: MLMap;
    try {
      map = new maplibregl.Map({
        container: el.current,
        style: STYLE[resolvedTheme],
        center: [74.1, 31.4],
        zoom: 8,
        attributionControl: { compact: true },
        cooperativeGestures: compact,
        dragRotate: false,
        pitchWithRotate: false,
        fadeDuration: prefersReducedMotion() ? 0 : 300,
      });
    } catch {
      setFailed(true);
      return;
    }
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    const install = () => {
      const root = getComputedStyle(document.documentElement);
      const ring = root.getPropertyValue("--page").trim() || "#fff";
      for (const s of STATUSES) {
        const name = `kiln-${s}`;
        if (map.hasImage(name)) map.removeImage(name);
        map.addImage(name, drawIcon(s, root.getPropertyValue(VAR[s]).trim(), ring), { pixelRatio: 2 });
      }
      if (!map.getSource("eox")) {
        map.addSource("eox", { type: "raster", tiles: [EOX_TILES], tileSize: 256, attribution: EOX_ATTR, maxzoom: 15 });
        map.addLayer({
          id: "eox",
          type: "raster",
          source: "eox",
          layout: { visibility: latest.current.satellite ? "visible" : "none" },
        });
      }
      if (!map.getSource("kilns")) {
        map.addSource("kilns", { type: "geojson", data: toGeoJSON(latest.current.kilns), promoteId: "id" });
        map.addLayer({
          id: "kiln-halo",
          type: "circle",
          source: "kilns",
          filter: ["==", ["get", "id"], latest.current.selectedId ?? ""],
          paint: {
            "circle-radius": 17,
            "circle-color": "rgba(0,0,0,0)",
            "circle-stroke-width": 3,
            "circle-stroke-color": root.getPropertyValue("--text").trim(),
          },
        });
        map.addSource("kiln-cols", { type: "geojson", data: toColumns(latest.current.kilns, latest.current.pFcbk) });
        map.addLayer({
          id: "kiln-cols",
          type: "fill-extrusion",
          source: "kiln-cols",
          layout: { visibility: latest.current.threeD ? "visible" : "none" },
          paint: {
            "fill-extrusion-color": [
              "match",
              ["get", "status"],
              "ZIGZAG",
              root.getPropertyValue("--zigzag").trim(),
              "FCBK",
              root.getPropertyValue("--fcbk").trim(),
              "UNDETERMINED",
              root.getPropertyValue("--undetermined").trim(),
              root.getPropertyValue("--notseen").trim(),
            ],
            "fill-extrusion-height": ["get", "h"],
            "fill-extrusion-base": 0,
            "fill-extrusion-opacity": 0.9,
          },
        });
        map.addLayer({
          id: "kilns",
          type: "symbol",
          source: "kilns",
          layout: {
            "icon-image": ["concat", "kiln-", ["get", "status"]],
            "icon-size": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 10, 0.8, 14, 1.05],
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "symbol-sort-key": ["get", "sort"],
            visibility: latest.current.threeD ? "none" : "visible",
          },
        });
      }
    };
    map.on("style.load", install);
    map.on("click", "kilns", (e) => {
      const id = e.features?.[0]?.properties?.id as string | undefined;
      if (id) latest.current.onSelect?.(id);
    });
    map.on("click", "kiln-cols", (e) => {
      const id = e.features?.[0]?.properties?.id as string | undefined;
      if (id) latest.current.onSelect?.(id);
    });
    map.on("mouseenter", "kiln-cols", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "kiln-cols", () => (map.getCanvas().style.cursor = ""));
    map.on("mouseenter", "kilns", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "kilns", () => (map.getCanvas().style.cursor = ""));
    map.on("error", () => undefined);
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(el.current);
    const canvas = map.getCanvas();
    canvas.setAttribute("aria-label", label);
    canvas.setAttribute("role", "region");
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme: swap the basemap; style.load re-installs our layers.
  const lastTheme = useRef(resolvedTheme);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || lastTheme.current === resolvedTheme) return;
    lastTheme.current = resolvedTheme;
    map.setStyle(STYLE[resolvedTheme], { diff: false });
  }, [resolvedTheme]);

  // Data.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("kilns") as GeoJSONSource | undefined;
      src?.setData(toGeoJSON(kilns));
      (map.getSource("kiln-cols") as GeoJSONSource | undefined)?.setData(toColumns(kilns, pFcbk));
      if (!fitted.current && !focus) {
        const b = bbox ?? extent(kilns);
        if (b) {
          map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: compact ? 24 : 48, duration: 0, maxZoom: 12 });
          fitted.current = true;
        }
      }
    };
    if (map.isStyleLoaded() && map.getSource("kilns")) apply();
    else map.once("idle", apply);
  }, [kilns, bbox, compact, focus, pFcbk]);

  // 3D: pitch the camera and swap the icons for extruded columns.
  const prev3D = useRef(threeD);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || prev3D.current === threeD) return;
    prev3D.current = threeD;
    const apply = () => {
      if (!map.getLayer("kiln-cols")) return;
      map.setLayoutProperty("kiln-cols", "visibility", threeD ? "visible" : "none");
      map.setLayoutProperty("kilns", "visibility", threeD ? "none" : "visible");
      map.setLayoutProperty("kiln-halo", "visibility", threeD ? "none" : "visible");
      if (threeD) map.dragRotate.enable();
      else map.dragRotate.disable();
      const reduced = prefersReducedMotion();
      map.easeTo({ pitch: threeD ? 55 : 0, bearing: threeD ? -18 : 0, zoom: map.getZoom() + (threeD ? 0.5 : -0.5), duration: reduced ? 0 : 900 });
    };
    if (map.isStyleLoaded() && map.getLayer("kiln-cols")) apply();
    else map.once("idle", apply);
  }, [threeD]);

  // Tour: fly through the scanned districts, ending on the densest FCBK cluster. Any interaction stops it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !tour || prefersReducedMotion()) return;
    const stops = tourStops(latest.current.kilns);
    let i = 0;
    let stopped = false;
    let timer = 0;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      map.stop();
      latest.current.onTourStop?.(null);
    };
    const next = () => {
      if (stopped) return;
      const s = stops[i++];
      if (!s) {
        stop();
        return;
      }
      latest.current.onTourStop?.(s.name);
      map.flyTo({ center: s.center, zoom: s.zoom, pitch: 55, bearing: -18 + i * 24, speed: 0.7, curve: 1.5, essential: false, easing: (x) => 1 - Math.pow(1 - x, 3) });
      map.once("moveend", () => {
        if (!stopped) timer = window.setTimeout(next, s.name === "FCBK" ? 4000 : 1800);
      });
    };
    const container = map.getContainer();
    const userStop = () => stop();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && stop();
    for (const ev of ["mousedown", "touchstart", "wheel", "keydown"]) container.addEventListener(ev, userStop, { passive: true });
    window.addEventListener("keydown", onKey);
    next();
    return () => {
      for (const ev of ["mousedown", "touchstart", "wheel", "keydown"]) container.removeEventListener(ev, userStop);
      window.removeEventListener("keydown", onKey);
      if (!stopped) map.stop();
      stopped = true;
      clearTimeout(timer);
    };
  }, [tour]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    map.jumpTo({ center: [focus.lon, focus.lat], zoom: focus.zoom ?? 13 });
  }, [focus]);

  // Selection halo.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => map.getLayer("kiln-halo") && map.setFilter("kiln-halo", ["==", ["get", "id"], selectedId ?? ""]);
    if (map.isStyleLoaded()) apply();
    else map.once("idle", apply);
  }, [selectedId]);

  // Satellite toggle.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => map.getLayer("eox") && map.setLayoutProperty("eox", "visibility", satellite ? "visible" : "none");
    if (map.isStyleLoaded()) apply();
    else map.once("idle", apply);
  }, [satellite]);

  return (
    <div className={`mapview ${className}`}>
      <div ref={el} className="mapview-canvas" />
      {failed && <p className="map-failed">{t.map.webglMissing}</p>}
    </div>
  );
}
