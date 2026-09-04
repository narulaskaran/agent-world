import type {
  CreateCharacterInput,
  DirectiveInput,
  ServerMessage,
  UpdateCharacterInput,
  WorldSnapshot,
} from "@agent-world/shared";
import type { WorldRepository } from "@agent-world/db";
import { WorldEngine } from "./world.js";

export class LocalRuntime {
  readonly engine: WorldEngine;
  private readonly listeners = new Set<(message: ServerMessage) => void>();
  private timers: NodeJS.Timeout[] = [];
  private viewers = 0;

  constructor(readonly repository: WorldRepository) {
    this.engine = new WorldEngine(repository, () => this.publish());
  }

  start(): void {
    this.timers.push(setInterval(() => void this.engine.runDueJobs(), 1_000));
    // Realtime frames are derived from persisted movement segments; this timer owns no world state.
    this.timers.push(setInterval(() => this.publish(), 1_000));
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  snapshot(): WorldSnapshot {
    return this.engine.snapshot(this.viewers);
  }

  subscribe(listener: (message: ServerMessage) => void): () => void {
    this.listeners.add(listener);
    this.viewers += 1;
    listener({ type: "snapshot", payload: this.snapshot() });
    this.publish();
    return () => {
      this.listeners.delete(listener);
      this.viewers = Math.max(0, this.viewers - 1);
      this.publish();
    };
  }

  private publish(): void {
    if (!this.listeners.size) return;
    const message: ServerMessage = {
      type: "snapshot",
      payload: this.snapshot(),
    };
    this.listeners.forEach((listener) => listener(message));
  }

  createCharacter(input: CreateCharacterInput) {
    return this.engine.createCharacter(input);
  }

  updateCharacter(name: string, input: UpdateCharacterInput): void {
    this.engine.updateCharacter(name, input);
  }

  addDirective(name: string, input: DirectiveInput): void {
    this.engine.addDirective(name, input);
  }

  regenerateAvatar(name: string): Promise<void> {
    return this.engine.regenerateAvatar(name);
  }

  deleteCharacter(name: string): void {
    this.engine.deleteCharacter(name);
  }

  setSimulationPaused(paused: boolean): void {
    this.engine.setSimulationPaused(paused);
  }

  setServerDailyBudgetMicros(serverDailyBudgetMicros: number): void {
    this.engine.setServerDailyBudgetMicros(serverDailyBudgetMicros);
  }

  resetWorld(): void {
    this.engine.resetWorld();
  }

  adminState() {
    return this.engine.adminState();
  }
}
