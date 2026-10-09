import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CommandReceipt,
  FleetSnapshot,
} from "../../../../packages/contracts/src";
import { CommandReceiptSchema } from "../../../../packages/contracts/src";
import { API, errorMessage, request } from "../lib/api";
import { mergeReceipt } from "../lib/display";

export type ConnectionState =
  "connecting" | "live" | "reconnecting" | "offline";

export function isSnapshot(value: unknown): value is FleetSnapshot {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<FleetSnapshot>;
  return (
    state.schemaVersion === 1 &&
    typeof state.controllerEpoch === "string" &&
    typeof state.revision === "number" &&
    Number.isFinite(state.revision) &&
    !!state.rules &&
    typeof state.rules.version === "number" &&
    [
      "agents",
      "goals",
      "tasks",
      "attempts",
      "observations",
      "reservations",
      "events",
    ].every((key) => Array.isArray((value as Record<string, unknown>)[key]))
  );
}

export function useFleet() {
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [receipts, setReceipts] = useState<Record<string, CommandReceipt>>({});
  const receiptsRef = useRef(receipts);
  receiptsRef.current = receipts;
  const lastSnapshotAt = useRef(0);
  const streamConnected = useRef(false);

  const receiveSnapshot = useCallback((value: unknown) => {
    if (!isSnapshot(value)) throw new Error("현황 응답을 확인할 수 없습니다.");
    setSnapshot((previous) =>
      previous &&
      (previous.updatedAt > value.updatedAt ||
        (previous.controllerEpoch === value.controllerEpoch &&
          previous.revision > value.revision))
        ? previous
        : value,
    );
    lastSnapshotAt.current = Date.now();
    setConnection(streamConnected.current ? "live" : "connecting");
    setError("");
  }, []);

  const receiveReceipt = useCallback((value: unknown) => {
    const receipt = CommandReceiptSchema.parse(value);
    setReceipts((previous) => ({
      ...previous,
      [receipt.id]: mergeReceipt(previous[receipt.id], receipt),
    }));
    return receipt;
  }, []);

  useEffect(() => {
    let disposed = false;
    const polling = new Set<string>();
    const controller = new AbortController();
    void request<unknown>("/snapshot", { signal: controller.signal })
      .then((data) => {
        if (!disposed) receiveSnapshot(data);
      })
      .catch((value) => {
        if (!disposed) {
          setError(errorMessage(value));
          setConnection("offline");
        }
      });
    const stream = new EventSource(`${API}/stream`);
    stream.onopen = () => {
      streamConnected.current = true;
      setConnection(lastSnapshotAt.current ? "live" : "connecting");
    };
    stream.addEventListener("snapshot", (event) => {
      try {
        streamConnected.current = true;
        receiveSnapshot(JSON.parse((event as MessageEvent<string>).data));
      } catch (value) {
        setError(errorMessage(value));
        setConnection("offline");
      }
    });
    stream.addEventListener("command", (event) => {
      try {
        receiveReceipt(JSON.parse((event as MessageEvent<string>).data));
      } catch (value) {
        setError(errorMessage(value));
      }
    });
    stream.onerror = () => {
      streamConnected.current = false;
      setConnection(lastSnapshotAt.current ? "reconnecting" : "offline");
    };
    const timer = window.setInterval(() => {
      setNow(Date.now());
      for (const receipt of Object.values(receiptsRef.current)) {
        if (receipt.state !== "accepted" && receipt.state !== "applying")
          continue;
        if (polling.has(receipt.id)) continue;
        polling.add(receipt.id);
        void request<unknown>(`/commands/${encodeURIComponent(receipt.id)}`, {
          signal: controller.signal,
        })
          .then((data) => {
            if (!disposed) receiveReceipt(data);
          })
          .catch(() => {
            /* Stream recovery provides current command state. */
          })
          .finally(() => polling.delete(receipt.id));
      }
    }, 1000);
    return () => {
      disposed = true;
      streamConnected.current = false;
      controller.abort();
      stream.close();
      window.clearInterval(timer);
    };
  }, [receiveReceipt, receiveSnapshot]);

  const dismissReceipt = useCallback(
    (id: string) =>
      setReceipts((previous) => {
        const next = { ...previous };
        delete next[id];
        return next;
      }),
    [],
  );

  return {
    snapshot,
    connection,
    error,
    now,
    receipts,
    receiveReceipt,
    dismissReceipt,
  };
}
