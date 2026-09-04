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
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!host.current || scene.current) return;
    const world = new WorldScene(host.current, (id) => onSelectRef.current(id));
    scene.current = world;
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
