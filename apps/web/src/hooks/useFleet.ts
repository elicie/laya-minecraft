import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CommandReceipt,
  FleetSnapshot,
} from "../../../../packages/contracts/src";
import {
  CommandReceiptSchema,
  FleetSnapshotSchema,
} from "../../../../packages/contracts/src";
import { API, errorMessage, request } from "../lib/api";
import { mergeReceipt } from "../lib/display";

export type ConnectionState =
  "connecting" | "live" | "reconnecting" | "offline";

const SNAPSHOT_PATH = "/snapshot?view=dashboard";
const SNAPSHOT_TIMEOUT_MS = 10_000;
const FALLBACK_INTERVAL_MS = 3_000;

type SnapshotRequest = {
  controller: AbortController;
  promise: Promise<FleetSnapshot>;
};

export function useFleet() {
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const snapshotRef = useRef<FleetSnapshot | null>(null);
  const retiredEpochs = useRef(new Set<string>());
  const snapshotRequest = useRef<SnapshotRequest | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [receipts, setReceipts] = useState<Record<string, CommandReceipt>>({});
  const receiptsRef = useRef(receipts);
  receiptsRef.current = receipts;
  const lastSnapshotAt = useRef(0);
  const snapshotGeneration = useRef(0);
  const streamConnected = useRef(false);

  const receiveSnapshot = useCallback((value: unknown) => {
    const parsed = FleetSnapshotSchema.safeParse(value);
    if (!parsed.success) throw new Error("현황 응답을 확인할 수 없습니다.");
    const state = parsed.data;
    const previous = snapshotRef.current;
    if (
      previous &&
      (retiredEpochs.current.has(state.controllerEpoch) ||
        previous.updatedAt > state.updatedAt ||
        (previous.controllerEpoch === state.controllerEpoch &&
          previous.revision > state.revision))
    )
      return false;
    if (previous && previous.controllerEpoch !== state.controllerEpoch)
      retiredEpochs.current.add(previous.controllerEpoch);
    snapshotRef.current = state;
    setSnapshot(state);
    lastSnapshotAt.current = Date.now();
    snapshotGeneration.current++;
    setConnection(
      streamConnected.current
        ? "live"
        : previous
          ? "reconnecting"
          : "connecting",
    );
    setError("");
    return true;
  }, []);

  const receiveReceipt = useCallback((value: unknown) => {
    const receipt = CommandReceiptSchema.parse(value);
    setReceipts((previous) => ({
      ...previous,
      [receipt.id]: mergeReceipt(previous[receipt.id], receipt),
    }));
    return receipt;
  }, []);

  const refreshSnapshot = useCallback((): Promise<FleetSnapshot> => {
    if (snapshotRequest.current) return snapshotRequest.current.promise;
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      SNAPSHOT_TIMEOUT_MS,
    );
    const pending: SnapshotRequest = {
      controller,
      promise: request<unknown>(SNAPSHOT_PATH, { signal: controller.signal })
        .then((data) => {
          // A late response from an aborted effect must not revive its session.
          controller.signal.throwIfAborted();
          receiveSnapshot(data);
          return snapshotRef.current!;
        })
        .finally(() => {
          window.clearTimeout(timeout);
          if (snapshotRequest.current === pending)
            snapshotRequest.current = null;
        }),
    };
    snapshotRequest.current = pending;
    return pending.promise;
  }, [receiveSnapshot]);

  useEffect(() => {
    let disposed = false;
    const polling = new Set<string>();
    const controller = new AbortController();
    let lastStreamSnapshotAt = Date.now();
    let fallback = false;
    let nextFallbackAt = 0;
    const loadSnapshot = () => {
      const startedGeneration = snapshotGeneration.current;
      void refreshSnapshot().catch((value) => {
        // A newer accepted snapshot has already proved the current connection.
        if (!disposed && snapshotGeneration.current === startedGeneration) {
          setError(errorMessage(value));
          setConnection(snapshotRef.current ? "reconnecting" : "offline");
        }
      });
    };
    loadSnapshot();
    const stream = new EventSource(`${API}/stream?view=dashboard`);
    stream.onopen = () => {
      if (disposed) return;
      streamConnected.current = true;
      // An open socket does not prove that a current snapshot reached us.
      if (
        !fallback &&
        lastSnapshotAt.current &&
        Date.now() - lastSnapshotAt.current < SNAPSHOT_TIMEOUT_MS
      )
        setConnection("live");
    };
    stream.addEventListener("snapshot", (event) => {
      if (disposed) return;
      try {
        streamConnected.current = true;
        if (receiveSnapshot(JSON.parse((event as MessageEvent<string>).data))) {
          lastStreamSnapshotAt = Date.now();
          fallback = false;
        }
      } catch (value) {
        setError(errorMessage(value));
        setConnection("offline");
        fallback = true;
      }
    });
    stream.addEventListener("command", (event) => {
      if (disposed) return;
      try {
        receiveReceipt(JSON.parse((event as MessageEvent<string>).data));
      } catch (value) {
        setError(errorMessage(value));
      }
    });
    stream.onerror = () => {
      if (disposed) return;
      streamConnected.current = false;
      fallback = true;
      setConnection(lastSnapshotAt.current ? "reconnecting" : "offline");
    };
    const timer = window.setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time - lastStreamSnapshotAt >= SNAPSHOT_TIMEOUT_MS) fallback = true;
      if (
        fallback &&
        (!lastSnapshotAt.current ||
          time - lastSnapshotAt.current >= SNAPSHOT_TIMEOUT_MS)
      )
        setConnection(snapshotRef.current ? "reconnecting" : "offline");
      if (fallback && time >= nextFallbackAt && !snapshotRequest.current) {
        nextFallbackAt = time + FALLBACK_INTERVAL_MS;
        loadSnapshot();
      }
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
      snapshotRequest.current?.controller.abort();
      snapshotRequest.current = null;
      stream.close();
      window.clearInterval(timer);
    };
  }, [receiveReceipt, receiveSnapshot, refreshSnapshot]);

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
    refreshSnapshot,
    dismissReceipt,
  };
}
