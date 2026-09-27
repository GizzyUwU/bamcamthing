import type { BridgethingClient } from '@bridgething/client';
import { useCallback, useEffect, useState } from 'react';
import { fetchSnapshot, probeImage, streamUrl, type BambuddyConfig } from './bambuddy';

export type Transport = 'idle' | 'probing' | 'direct' | 'tunnel';

export type Feed = {
  url: string | null;
  transport: Transport;
  frames: number;
  lastFrameAt: number | null;
  error: string | null;
  retry: () => void;
  tunnelOnly: () => void;
};

const IDLE: Feed = { url: null, transport: 'idle', frames: 0, lastFrameAt: null, error: null, retry: () => {}, tunnelOnly: () => {} };

const probeTimeoutMs = 8000;
const errorBackoffMs = 4000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function useFeed(client: BridgethingClient, cfg: BambuddyConfig | null, live: boolean): Feed {
  const [nonce, setNonce] = useState(0);
  const [forced, setForced] = useState(false);
  const [feed, setFeed] = useState<Feed>(IDLE);

  const retry = useCallback(() => {
    setForced(false);
    setNonce(n => n + 1);
  }, []);

  const tunnelOnly = useCallback(() => setForced(true), []);

  const identity = cfg ? JSON.stringify(cfg) : '';
  const wantDirect = live && cfg?.direct === true && !forced;

  useEffect(() => {
    if (!live || !cfg || !cfg.token) {
      setFeed(IDLE);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    let frames = 0;

    const publish = (next: Partial<Feed>) => {
      if (cancelled) return;
      setFeed(prev => ({ ...prev, ...next }));
    };

    const releaseObjectUrl = () => {
      if (!objectUrl) return;
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    };

    const poll = async () => {
      publish({ transport: 'tunnel', error: null });
      while (!cancelled) {
        try {
          const blob = await fetchSnapshot(client, cfg, nonce + frames);
          if (cancelled) return;
          const next = URL.createObjectURL(blob);
          const previous = objectUrl;
          objectUrl = next;
          frames += 1;
          publish({ url: next, transport: 'tunnel', frames, lastFrameAt: Date.now() });
          if (previous) URL.revokeObjectURL(previous);
          await sleep(cfg.pollMs);
        } catch (err) {
          publish({ error: err instanceof Error ? err.message : String(err) });
          await sleep(errorBackoffMs);
        }
      }
    };

    const start = async () => {
      if (wantDirect) {
        publish({ transport: 'probing' });
        const stream = streamUrl(cfg, nonce);
        const reachable = await probeImage(stream, probeTimeoutMs);
        if (cancelled) return;
        if (reachable) {
          publish({ url: stream, transport: 'direct', error: null });
          return;
        }
      }
      await poll();
    };

    void start();
    return () => {
      cancelled = true;
      releaseObjectUrl();
    };
  }, [client, identity, nonce, wantDirect, live]);

  return { ...feed, retry, tunnelOnly };
}
