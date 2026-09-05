import { useEffect, useRef } from "react";
import type { WorldSnapshot } from "@agent-world/shared";
import { WorldScene } from "./world-scene";

interface Props {
  snapshot: WorldSnapshot | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function WorldCanvas({ snapshot, selectedId, onSelect }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<WorldScene | null>(null);
  const onSelectRef = useRef(onSelect);
  const snapshotRef = useRef(snapshot);
  const selectedRef = useRef(selectedId);
  onSelectRef.current = onSelect;
  snapshotRef.current = snapshot;
  selectedRef.current = selectedId;

  useEffect(() => {
    if (!host.current) return;
    const world = new WorldScene(host.current, (id) => onSelectRef.current(id));
    scene.current = world;
    if (snapshotRef.current)
      world.sync(snapshotRef.current, selectedRef.current);
    return () => {
      world.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    if (snapshot) scene.current?.sync(snapshot, selectedId);
  }, [snapshot, selectedId]);

  return (
    <div
      className="world-canvas"
      ref={host}
      aria-label="Agent World shared map"
    />
  );
}
