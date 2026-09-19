import { useEffect, useRef, useState } from "react";
import type { ServerMessage, WorldSnapshot } from "@agent-world/shared";
import { API_URL } from "./api";

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

export function websocketUrl(apiUrl: string, locationOrigin: string): string {
  const base = (apiUrl || locationOrigin).replace(/\/$/, "");
  return `${base.replace(/^http/i, "ws")}/ws`;
}

/** 1s, doubling, capped at 30s. `attempt` is 0 after the first disconnect. */
export function reconnectDelayMs(attempt: number): number {
  const delay = INITIAL_RECONNECT_MS * 2 ** Math.max(0, attempt);
  return Math.min(delay, MAX_RECONNECT_MS);
}

export function useWorld() {
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const attemptRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let timer = 0;

    const connect = () => {
      if (cancelled) return;
      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      socket = new WebSocket(websocketUrl(API_URL, origin));
      socket.onopen = () => {
        if (!cancelled) setConnected(true);
      };
      socket.onmessage = (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }
        attemptRef.current = 0;
        if (message.type === "snapshot") setSnapshot(message.payload);
      };
      socket.onclose = () => {
        setConnected(false);
        if (cancelled) return;
        const delay = reconnectDelayMs(attemptRef.current);
        attemptRef.current += 1;
        timer = window.setTimeout(connect, delay);
      };
      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, []);

  return { snapshot, connected };
}
