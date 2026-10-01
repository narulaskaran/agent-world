import type {
  CharacterInspect,
  CreateCharacterInput,
  DirectiveInput,
  ServerMessage,
  UpdateCharacterInput,
  WorldRecap,
  WorldSnapshot,
} from "@agent-world/shared";
import type { WorldRepository } from "@agent-world/db";
import type { PaidServices } from "./services.js";
import { WorldEngine, type WorldEngineOptions } from "./world.js";

const TICK_MS = 1_000;
/** Clients interpolate movement from arrival times, so idle frames are rare. */
const HEARTBEAT_MS = 5_000;
const PUBLISH_COALESCE_MS = 150;
const PRUNE_MS = 10 * 60_000;

export class LocalRuntime {
  readonly engine: WorldEngine;
  private readonly listeners = new Set<(message: ServerMessage) => void>();
  private timers: NodeJS.Timeout[] = [];
  private publishTimer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;

  constructor(
    readonly repository: WorldRepository,
    services?: PaidServices,
    options: WorldEngineOptions = {},
  ) {
    this.engine = new WorldEngine(
      repository,
      () => this.schedulePublish(),
      services,
      options,
    );
  }

  start(): void {
    this.repository.recoverAfterRestart();
    this.repository.prune();
    this.timers.push(
      setInterval(() => {
        if (this.ticking) return;
        this.ticking = this.engine.runDueJobs().finally(() => {
          this.ticking = null;
        });
      }, TICK_MS),
      setInterval(() => this.publish(), HEARTBEAT_MS),
      setInterval(() => this.repository.prune(), PRUNE_MS),
    );
  }

  /** Stops scheduling and waits for the job in flight so leases are released. */
  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = null;
    await this.ticking;
  }

  snapshot(): WorldSnapshot {
    return this.engine.snapshot();
  }

  subscribe(listener: (message: ServerMessage) => void): () => void {
    this.listeners.add(listener);
    listener({ type: "snapshot", payload: this.snapshot() });
    return () => {
      this.listeners.delete(listener);
    };
  }

  private schedulePublish(): void {
    if (this.publishTimer || !this.listeners.size) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.publish();
    }, PUBLISH_COALESCE_MS);
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

  seedStarterCast(): Promise<number> {
    return this.engine.seedStarterCast();
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

  avatar(idOrName: string): string | null {
    return this.repository.avatarFor(idOrName);
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

  setDecisionScale(decisionScale: number): void {
    this.engine.setDecisionScale(decisionScale);
  }

  resetWorld(): void {
    this.engine.resetWorld();
  }

  adminState() {
    return this.engine.adminState();
  }

  recap(since: number): WorldRecap {
    return this.engine.recap(since);
  }

  inspectCharacter(idOrName: string): CharacterInspect | null {
    return this.repository.inspect(idOrName);
  }
}
