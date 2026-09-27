import type { BridgethingClient, ConfigEntry } from '@bridgething/client';

export type BambuddyConfig = {
  baseUrl: string;
  printerId: number;
  token: string;
  fps: number;
  pollMs: number;
  direct: boolean;
};

export const defaultConfig = {
  baseUrl: '',
  printerId: 1,
  token: '',
  fps: 5,
  pollMs: 2500,
  direct: true,
  fpsChoices: [1, 2, 5, 10, 15],
};

function num(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readConfig(entries: ConfigEntry[]): BambuddyConfig {
  const at = (key: string) => entries.find(entry => entry.key === key)?.value;
  return {
    baseUrl: (at('base_url') || '').replace(/\/+$/, ''),
    printerId: Math.round(num(at('printer_id'), defaultConfig.printerId)),
    token: (at('token') || '').trim(),
    fps: num(at('fps'), defaultConfig.fps),
    pollMs: num(at('poll_ms'), defaultConfig.pollMs),
    direct: at('direct') === undefined ? defaultConfig.direct : at('direct') === 'true',
  };
}

export type OverlayStatus = {
  id: number;
  name: string;
  camera_rotation: number;
  connected: boolean;
  state: string;
  current_print: string | null;
  gcode_file: string | null;
  progress: number;
  remaining_time: number | null;
  layer_num: number | null;
  total_layers: number | null;
  stg_cur_name: string | null;
  temperatures: { nozzle: number; nozzle_target: number; bed: number; bed_target: number } | null;
};

export const printingStates = new Set(['PREPARE', 'RUNNING', 'PAUSE', 'FINISH', 'FAILED']);

export function streamUrl(cfg: BambuddyConfig, nonce: number): string {
  const fps = Math.min(30, Math.max(1, Math.round(cfg.fps)));
  return `${cfg.baseUrl}/api/v1/printers/${cfg.printerId}/camera/stream?fps=${fps}&token=${encodeURIComponent(cfg.token)}&n=${nonce}`;
}

export function snapshotUrl(cfg: BambuddyConfig, nonce: number): string {
  return `${cfg.baseUrl}/api/v1/printers/${cfg.printerId}/camera/snapshot?token=${encodeURIComponent(cfg.token)}&n=${nonce}`;
}

export function statusUrl(cfg: BambuddyConfig): string {
  return `${cfg.baseUrl}/api/v1/printers/${cfg.printerId}/overlay-status?token=${encodeURIComponent(cfg.token)}`;
}

const netTimeoutMs = 20_000;

function netErrorText(error: unknown): string {
  const payload = (error as { error?: unknown } | null)?.error ?? error;
  const type = (payload as { type?: string } | null)?.type;
  const reason = (payload as { data?: { reason?: string } } | null)?.data?.reason;
  if (type === 'timeout') return 'the phone timed out waiting for bambuddy';
  if (type === 'noGateway') return 'no phone is connected';
  if (type === 'unavailable') return 'the phone has no route to the internet';
  if (type === 'requestFailed') return `the phone could not reach bambuddy${reason ? `: ${reason}` : ''}`;
  if (type === 'invalidConfigValue' || type === 'unknownConfigKey')
    return `bambuddy rejected the settings: ${(error as { data?: { reason?: string } }).data?.reason ?? type}`;
  if (type === 'resourceNotAvailable') return 'the device refused the request, check the app permissions';
  if (type === 'handlerFailed' || type === 'malformed') return `the daemon failed: ${reason ?? type}`;
  if (!type) return `the daemon failed: ${JSON.stringify(error).slice(0, 100)}`;
  return `the daemon said ${type}${reason ? `: ${reason}` : ''}`;
}

async function netFetch(client: BridgethingClient, url: string): Promise<Uint8Array> {
  const deadline = netTimeoutMs + 5_000;
  let reply: Awaited<ReturnType<BridgethingClient['net']['fetch']>>;
  try {
    reply = await client.net.fetch(
      { request: { url, method: 'GET', headers: [], body: null, timeoutMs: netTimeoutMs, redirect: 'follow' } },
      { timeoutMs: deadline },
    );
  } catch (err) {
    throw new Error(`bambuddy did not answer in ${Math.round(deadline / 1000)}s, the camera is busy or offline`);
  }
  if (!reply.ok) throw new Error(netErrorText(reply.error));
  const { response } = reply.response;
  if (response.status === 401 || response.status === 403)
    throw new Error('bambuddy rejected the token, make a new one on its printers page');
  if (response.status === 503) throw new Error('bambuddy is busy (503), it serves one camera reader at a time');
  if (response.status >= 400) throw new Error(`bambuddy answered ${response.status}`);
  return response.body as Uint8Array;
}

export async function fetchStatus(client: BridgethingClient, cfg: BambuddyConfig): Promise<OverlayStatus> {
  const body = await netFetch(client, statusUrl(cfg));
  return JSON.parse(new TextDecoder().decode(body)) as OverlayStatus;
}

export async function fetchSnapshot(client: BridgethingClient, cfg: BambuddyConfig, nonce: number): Promise<Blob> {
  const body = await netFetch(client, snapshotUrl(cfg, nonce));
  return new Blob([body as BlobPart], { type: 'image/jpeg' });
}

export function probeImage(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const img = new Image();
    const done = (ok: boolean) => {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    img.onload = () => done(img.naturalWidth > 0);
    img.onerror = () => done(false);
    img.src = url;
  });
}

export function prettyDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return '--';
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}
