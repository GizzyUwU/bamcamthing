import { BridgethingClient, type ConnectionState, type TimeSnapshot } from '@bridgething/client';
import { useCallback, useEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import {
  defaultConfig,
  printingStates,
  fetchStatus,
  prettyDuration,
  readConfig,
  type BambuddyConfig,
  type OverlayStatus,
} from './bambuddy';
import { daemonUrl } from './daemon';
import { useFeed } from './useFeed';
import { isZoomed, useZoom, zoomStyle } from './useZoom';

const statusPollMs = 2500;
const views = ['print', 'detail', 'clean'] as const;
type View = (typeof views)[number];

function stateTone(state: string): string {
  if (state === 'RUNNING') return 'border-ok/40 bg-ok-soft text-ok';
  if (state === 'PAUSE') return 'border-warn/40 bg-warn-soft text-warn';
  if (state === 'FAILED') return 'border-err/40 bg-err-soft text-err';
  if (printingStates.has(state)) return 'border-accent/40 bg-accent-soft text-accent';
  return 'border-rule bg-neutral-soft text-dim';
}

function useClock(client: BridgethingClient): Date {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let skew = 0;
    const apply = (snapshot: TimeSnapshot) => {
      if (snapshot.time.wallClockUnixS) skew = snapshot.time.wallClockUnixS * 1000 - Date.now();
    };
    const offSnapshot = client.time.onSnapshot(apply);
    const offChanged = client.time.onChanged(apply);
    client.time.get().then(reply => reply.ok && apply(reply.response));
    const timer = setInterval(() => setNow(Date.now() + skew), 5000);
    return () => {
      offSnapshot();
      offChanged();
      clearInterval(timer);
    };
  }, [client]);
  return new Date(now);
}

function useBambuddyConfig(client: BridgethingClient): BambuddyConfig | null {
  const [config, setConfig] = useState<BambuddyConfig | null>(null);
  useEffect(() => {
    let alive = true;
    const apply = () => {
      client.config.list().then(reply => {
        if (alive && reply.ok) setConfig(readConfig(reply.response.entries));
      });
    };
    apply();
    const off = client.config.onChanged(apply);
    return () => {
      alive = false;
      off();
    };
  }, [client]);
  return config;
}

function useStatus(client: BridgethingClient, config: BambuddyConfig | null): OverlayStatus | null {
  const [status, setStatus] = useState<OverlayStatus | null>(null);
  useEffect(() => {
    if (!config?.token) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await fetchStatus(client, config);
        if (alive) setStatus(next);
      } catch {
        if (alive) setStatus(null);
      }
      if (alive) timer = setTimeout(tick, statusPollMs);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [client, config]);
  return status;
}

function useFpsOverride(client: BridgethingClient): [number | null, (next: number) => void] {
  const [fps, setFps] = useState<number | null>(null);
  useEffect(() => {
    client.store.get({ key: 'fps' }).then(reply => {
      if (reply.ok && reply.response.value) {
        const parsed = Number(reply.response.value);
        if (defaultConfig.fpsChoices.includes(parsed)) setFps(parsed);
      }
    });
  }, [client]);
  const choose = useCallback(
    (next: number) => {
      setFps(next);
      void client.store.put({ key: 'fps', value: String(next) });
    },
    [client],
  );
  return [fps, choose];
}

export default function App() {
  const client = useMemo(() => new BridgethingClient({ url: daemonUrl() }), []);
  const [conn, setConn] = useState<ConnectionState>(client.connectionState);
  const [view, setView] = useState<View>('print');
  const [diagnostics, setDiagnostics] = useState(false);

  const stored = useBambuddyConfig(client);
  const [fpsOverride, setFps] = useFpsOverride(client);
  const config = useMemo<BambuddyConfig | null>(
    () => (stored ? { ...stored, fps: fpsOverride ?? stored.fps } : null),
    [stored, fpsOverride],
  );

  const feed = useFeed(client, config, true);
  const status = useStatus(client, config);
  const now = useClock(client);

  useEffect(() => {
    const off = client.on(event => {
      if (event.type !== 'message') setConn(client.connectionState);
    });
    return off;
  }, [client]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '1') setView(view === 'clean' ? 'print' : 'clean');
      else if (event.key === '2') setDiagnostics(on => !on);
      else if (event.key === '3') feed.retry();
      else if (event.key === '4' && config) {
        const at = defaultConfig.fpsChoices.indexOf(config.fps);
        setFps(defaultConfig.fpsChoices[(at + 1) % defaultConfig.fpsChoices.length]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [config, feed, setFps]);

  const wheel = useRef(0);
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    wheel.current += event.deltaX;
    if (Math.abs(wheel.current) < 40) return;
    wheel.current = 0;
    setView(current => views[(views.indexOf(current) + 1) % views.length]);
  };

  const live = status ? printingStates.has(status.state) : false;
  const quarter = status ? (((Math.round(status.camera_rotation / 90) % 4) + 4) % 4) * 90 : 0;
  const showChrome = view !== 'clean';
  const root = useRef<HTMLDivElement>(null);
  const { zoom, handlers } = useZoom(!showChrome, root, quarter);
  const progress = Math.min(100, Math.max(0, status?.progress ?? 0));
  const temps = status?.temperatures ?? null;
  const missing = config ? !config.token || !config.baseUrl : true;
  const missingWhat = config?.baseUrl ? 'bambuddy base url' : 'token';

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-screen select-none"
      onWheel={onWheel}
      {...handlers}
      style={showChrome ? undefined : { touchAction: 'none' }}>
      {feed.url ? (
        <img
          src={feed.url}
          alt=""
          onError={feed.tunnelOnly}
          className="absolute inset-0 h-full w-full object-cover"
          style={{ transform: zoomStyle(zoom, quarter), willChange: 'transform' }}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center bg-screen px-16 text-center">
          <div className="flex flex-col gap-3">
            <div className="font-display text-title tracking-display text-soft">
              {missing ? `no bambuddy ${missingWhat}` : feed.transport === 'probing' ? 'looking for bambuddy' : 'no camera frames'}
            </div>
            <div className="font-mono text-hint text-dim">
              {missing
                ? 'set the base url and stream token in this app settings on your phone'
                : (feed.error ?? conn)}
            </div>
            {feed.error ? (
              <div className="font-mono text-hint text-dim">
                bambuddy serves one camera reader at a time, close the obs overlay if it is open
              </div>
            ) : null}
          </div>
        </div>
      )}

      {showChrome && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/75 to-transparent px-5 pt-3 pb-10">
            <div className="flex items-baseline justify-between">
              <div className="flex items-baseline gap-3">
                <span className="font-display text-title font-medium tracking-display text-off-white">
                  {status?.name ?? 'bamcamthing'}
                </span>
                <span
                  className={`rounded-full border px-2 py-0.5 font-mono text-hint tracking-[0.15em] uppercase ${stateTone(status?.state ?? 'UNKNOWN')}`}>
                  {status?.stg_cur_name ?? status?.state ?? 'unknown'}
                </span>
              </div>
              <span className="font-mono text-row text-near tabular-nums">
                {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </div>

          {view === 'print' && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-5 pt-16 pb-4">
              <div className="font-display text-hero leading-tight tracking-display text-off-white">
                {status?.current_print ?? (status ? 'idle' : 'waiting for the printer')}
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-off-white/15">
                <div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${progress}%` }} />
              </div>
              <div className="mt-2 flex items-baseline justify-between font-mono text-hint text-near">
                <span className="tabular-nums">
                  {progress.toFixed(0)}% · layer {status?.layer_num ?? '--'}/{status?.total_layers ?? '--'} ·{' '}
                  {prettyDuration(status?.remaining_time ?? null)} left
                </span>
                <span className="tabular-nums">
                  {temps ? `nozzle ${temps.nozzle.toFixed(0)}°/${temps.nozzle_target.toFixed(0)}° · bed ${temps.bed.toFixed(0)}°/${temps.bed_target.toFixed(0)}°` : '--'}
                </span>
              </div>
            </div>
          )}

          {view === 'detail' && (
            <div className="absolute top-14 right-0 h-[calc(100%-3.5rem)] w-72 overflow-y-auto border-l border-rule bg-screen/85 p-4 backdrop-blur">
              <Row label="state" value={`${status?.state ?? '--'} · ${status?.connected ? 'connected' : 'offline'}`} />
              <Row label="printer" value={`#${config?.printerId ?? defaultConfig.printerId} · ${quarter}°`} />
              <Row label="part" value={status?.gcode_file ?? '--'} />
              <Row label="progress" value={`${progress.toFixed(1)}%`} />
              <Row label="layer" value={`${status?.layer_num ?? '--'} / ${status?.total_layers ?? '--'}`} />
              <Row label="remaining" value={prettyDuration(status?.remaining_time ?? null)} />
              <Row label="nozzle" value={temps ? `${temps.nozzle.toFixed(1)}° / ${temps.nozzle_target.toFixed(0)}°` : '--'} />
              <Row label="bed" value={temps ? `${temps.bed.toFixed(1)}° / ${temps.bed_target.toFixed(0)}°` : '--'} />
              <div className="mt-2 border-t border-rule pt-2">
                <div className="font-mono text-hint tracking-[0.2em] text-dim uppercase">feed</div>
                <Row label="bambuddy" value={config?.baseUrl ? new URL(config.baseUrl).host : '--'} />
                <Row label="transport" value={feed.transport === 'direct' ? 'mjpeg stream' : feed.transport} />
                <Row
                  label={feed.transport === 'direct' ? 'rate' : 'frames'}
                  value={
                    feed.transport === 'direct'
                      ? `${config?.fps ?? defaultConfig.fps} fps asked`
                      : `${feed.frames} · every ${config?.pollMs ?? defaultConfig.pollMs} ms`
                  }
                />
                <Row label="daemon" value={conn} />
                {feed.error ? <div className="pt-1 font-mono text-hint text-warn">{feed.error}</div> : null}
                <div className="pt-1 font-mono text-hint text-dim">1 chrome · 2 diag · 3 retry · 4 fps</div>
              </div>
            </div>
          )}
        </>
      )}

      {diagnostics && view !== 'detail' && (
        <div className="pointer-events-none absolute top-14 left-5 rounded bg-screen/80 px-2 py-1 font-mono text-hint text-dim">
          {feed.transport === 'direct'
            ? `mjpeg ${config?.fps ?? defaultConfig.fps} fps · ${conn}`
            : `${feed.transport} · ${feed.frames} frames · ${conn}`}
          {feed.error ? ` · ${feed.error}` : ''}
        </div>
      )}

      {live && view === 'print' && (
        <div className="pointer-events-none absolute top-14 right-5 h-2 w-2 animate-pulse rounded-full bg-ok" />
      )}

      {view === 'clean' && isZoomed(zoom) && (
        <div className="pointer-events-none absolute right-4 bottom-3 rounded bg-screen/70 px-2 py-1 font-mono text-hint text-near tabular-nums">
          {zoom.scale.toFixed(1)}x · pinch to zoom, drag to look, double tap to reset
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="font-mono text-hint tracking-[0.15em] text-dim uppercase">{label}</span>
      <span className="truncate text-right font-mono text-row text-near">{value}</span>
    </div>
  );
}
