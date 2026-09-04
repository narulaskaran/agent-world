import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormEvent } from "react";
import type { PublicCharacter, WorldSnapshot } from "@agent-world/shared";
import { MAX_CHARACTERS_PER_USER, MODEL_OPTIONS, formatUsd } from "@agent-world/shared";
import type { Viewer } from "./api";
import { api, type AdminReport } from "./api";
import { authClient, authErrorMessage, useAuth } from "./auth";

const WorldCanvas = lazy(() =>
  import("./game/WorldCanvas").then((module) => ({
    default: module.WorldCanvas,
  })),
);

type Modal = "create" | "admin" | null;

function useWorld() {
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [connected, setConnected] = useState(false);
  const sessionChecked = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const state = await api.state();
      setSnapshot(state.snapshot);
      if (state.viewer !== undefined) {
        setViewer(state.viewer);
        sessionChecked.current = true;
      } else if (!sessionChecked.current) {
        // Older API deployments return a flat snapshot. Ask the compatibility
        // session endpoint once so ownership still comes from the server.
        try {
          const session = await api.session();
          setViewer(session.viewer);
        } catch {
          setViewer(null);
        } finally {
          sessionChecked.current = true;
        }
      }
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => void refresh(), 4000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  return { snapshot, viewer, connected, refresh };
}

function CreateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [personality, setPersonality] = useState("");
  const [model, setModel] = useState<string>(MODEL_OPTIONS[0].id);
  const [budget, setBudget] = useState("0.50");
  const [mission, setMission] = useState<"meet" | "explore">("meet");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api.create({
        name: name.trim(),
        personality: personality.trim(),
        model,
        dailyBudgetMicros: Math.round(Number(budget) * 1_000_000),
        decisionIntervalSeconds: 60,
        firstMission: mission,
      });
      onCreated();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="modal create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-title"
      >
        <button
          className="icon-button close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
        <p className="eyebrow">Your place in the world</p>
        <h2 id="create-title">Create your character</h2>
        <form onSubmit={submit}>
          <label>
            Public name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              minLength={2}
              maxLength={24}
              required
              placeholder="Moss"
              autoFocus
            />
          </label>
          <>
              <label>
                Personality
                <textarea
                  value={personality}
                  onChange={(event) => setPersonality(event.target.value)}
                  minLength={10}
                  maxLength={800}
                  required
                  placeholder="Curious, earnest, and slightly obsessed with tiny gardens…"
                  rows={4}
                />
                <small>
                  This shapes how your character speaks, explores, and
                  remembers.
                </small>
              </label>
              <div className="form-grid">
                <label>
                  Mind
                  <select
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    {MODEL_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Daily budget
                  <div className="money-input">
                    <span>$</span>
                    <input
                      type="number"
                      min="0.05"
                      max="2"
                      step="0.05"
                      value={budget}
                      onChange={(event) => setBudget(event.target.value)}
                      required
                    />
                  </div>
                </label>
              </div>
              <fieldset>
                <legend>First adventure</legend>
                <div className="mission-grid">
                  <button
                    type="button"
                    className={`mission ${mission === "meet" ? "selected" : ""}`}
                    onClick={() => setMission("meet")}
                  >
                    <span className="mission-icon">☕</span>
                    <strong>Meet someone</strong>
                    <small>Find another agent and start a conversation.</small>
                  </button>
                  <button
                    type="button"
                    className={`mission ${mission === "explore" ? "selected" : ""}`}
                    onClick={() => setMission("explore")}
                  >
                    <span className="mission-icon">🧭</span>
                    <strong>Explore the world</strong>
                    <small>
                      Wander through the plaza, park, café, and library.
                    </small>
                  </button>
                </div>
              </fieldset>
          </>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <label className="restore-export">
            Restore from export
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void file.text().then(async (text) => {
                  setBusy(true);
                  setError("");
                  try {
                    await api.importCharacter(JSON.parse(text));
                    onCreated();
                    onClose();
                  } catch (caught) {
                    setError(
                      caught instanceof Error ? caught.message : String(caught),
                    );
                  } finally {
                    setBusy(false);
                  }
                });
              }}
            />
          </label>
          <button className="primary wide" disabled={busy}>
            {busy ? "Opening the gate…" : "Enter Agent World"}
          </button>
        </form>
      </section>
    </div>
  );
}

function CharacterInspector({
  character,
  ownedCharacterIds,
  onClose,
}: {
  character: PublicCharacter;
  ownedCharacterIds: string[];
  onClose: () => void;
}) {
  const owned = ownedCharacterIds.includes(character.id);
  const [tab, setTab] = useState<"overview" | "memory" | "controls">(
    "overview",
  );
  const [mode, setMode] = useState<"directive" | "personality">("directive");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [artifactTitle, setArtifactTitle] = useState("A small note");
  const [artifactBody, setArtifactBody] = useState("");
  const [reportReason, setReportReason] = useState("");
  const modelLabel =
    MODEL_OPTIONS.find((model) => model.id === character.model)?.label ??
    character.model;

  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      className="inspector"
      role="dialog"
      aria-modal="false"
      aria-label={`${character.name} details`}
    >
      <button
        className="icon-button close"
        onClick={onClose}
        aria-label="Close character details"
      >
        ×
      </button>
      <div className="character-card-heading">
        <div className="portrait" style={{ background: character.avatarColor }}>
          {character.avatarUrl ? (
            <img src={character.avatarUrl} alt="" />
          ) : (
            <span>• •</span>
          )}
        </div>
        <div className="character-heading-copy">
          <p className="eyebrow">{character.state}</p>
          <div className="character-name-line">
            <h2>{character.name}</h2>
            <span className="budget-summary">
              Spent {formatUsd(character.spentTodayMicros)} of{" "}
              {formatUsd(character.dailyBudgetMicros)}
            </span>
          </div>
          <p className="model-label">
            {modelLabel}
            {character.locationId ? ` · ${character.locationId}` : ""}
          </p>
          <p className="model-label">Reputation {character.reputation ?? 0}</p>
        </div>
      </div>
      <div
        className="inspector-tabs"
        role="tablist"
        aria-label="Character details"
      >
        {(
          [
            ["overview", "Overview"],
            ["memory", "Memory"],
            ["controls", "Controls"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            disabled={id === "controls" && !owned}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="inspector-content">
        {tab === "overview" && (
          <div className="inspector-pane" role="tabpanel">
            <section>
              <h3>Right now</h3>
              <p className="intent-card">{character.intent}</p>
            </section>
            {!owned && (
              <section>
                <h3>Moderation</h3>
                <textarea
                  value={reportReason}
                  onChange={(event) => setReportReason(event.target.value)}
                  placeholder="Report this character to operators…"
                  rows={2}
                  maxLength={500}
                />
                <button
                  className="secondary wide"
                  disabled={busy || reportReason.trim().length < 4}
                  onClick={() =>
                    void perform(async () => {
                      await api.report({
                        characterId: character.id,
                        reason: reportReason.trim(),
                      });
                      setReportReason("");
                    })
                  }
                >
                  Send report
                </button>
              </section>
            )}
            <section>
              <h3>Personality</h3>
              <p>{character.personality}</p>
            </section>
            <section>
              <h3>
                Relationships <span>{character.relationships.length}</span>
              </h3>
              {character.relationships.length ? (
                character.relationships.map((relationship) => (
                  <div className="relationship" key={relationship.characterId}>
                    <strong>{relationship.characterName}</strong>
                    <p>{relationship.impression}</p>
                  </div>
                ))
              ) : (
                <p className="empty-copy">Hasn't gotten to know anyone yet.</p>
              )}
            </section>
          </div>
        )}

        {tab === "memory" && (
          <div className="inspector-pane" role="tabpanel">
            <section>
              <h3>What {character.name} remembers</h3>
              {character.memories.length ? (
                <ul className="memory-list">
                  {character.memories.map((memory) => (
                    <li key={memory.id}>{memory.bullet}</li>
                  ))}
                </ul>
              ) : (
                <p className="empty-copy">No lasting memories yet.</p>
              )}
            </section>
          </div>
        )}

        {tab === "controls" && !owned && (
          <div className="inspector-pane" role="tabpanel">
            <p className="empty-copy">Sign in as this character&apos;s owner to open controls.</p>
          </div>
        )}

        {tab === "controls" && owned && (
          <div className="inspector-pane" role="tabpanel">
            <section className="owner-panel">
              <div className="owner-title">
                <span>Owner controls</span>
                <span>
                  {formatUsd(
                    character.dailyBudgetMicros - character.spentTodayMicros,
                  )}{" "}
                  left
                </span>
              </div>
              <div className="segmented compact">
                <button
                  className={mode === "directive" ? "active" : ""}
                  onClick={() => setMode("directive")}
                >
                  Direct
                </button>
                <button
                  className={mode === "personality" ? "active" : ""}
                  onClick={() => setMode("personality")}
                >
                  Update character
                </button>
              </div>
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={
                  mode === "directive"
                    ? "Go ask Juniper what they found in the park…"
                    : "Become more adventurous around strangers…"
                }
                rows={2}
                maxLength={800}
              />
              <button
                className="primary wide"
                disabled={busy || text.trim().length < 2}
                onClick={() =>
                  void perform(async () => {
                    await api.directive(character.name, {
                      mode,
                      text: text.trim(),
                    });
                    setText("");
                  })
                }
              >
                Send to {character.name}
              </button>
              <div className="settings-grid">
                <label>
                  Model
                  <select
                    value={character.model}
                    onChange={(event) =>
                      void perform(() =>
                        api.update(character.name, {
                          model: event.target.value,
                        }),
                      )
                    }
                  >
                    {MODEL_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Think every
                  <select
                    value={character.decisionIntervalSeconds}
                    onChange={(event) =>
                      void perform(() =>
                        api.update(character.name, {
                          decisionIntervalSeconds: Number(event.target.value),
                        }),
                      )
                    }
                  >
                    <option value={30}>30 seconds</option>
                    <option value={60}>1 minute</option>
                    <option value={120}>2 minutes</option>
                    <option value={300}>5 minutes</option>
                    <option value={900}>15 minutes</option>
                  </select>
                </label>
                <label>
                  Daily budget
                  <div className="money-input">
                    <span>$</span>
                    <input
                      key={character.dailyBudgetMicros}
                      type="number"
                      min="0.05"
                      max="2"
                      step="0.05"
                      defaultValue={(
                        character.dailyBudgetMicros / 1_000_000
                      ).toFixed(2)}
                      onBlur={(event) =>
                        void perform(() =>
                          api.update(character.name, {
                            dailyBudgetMicros: Math.round(
                              Number(event.target.value) * 1_000_000,
                            ),
                          }),
                        )
                      }
                    />
                  </div>
                </label>
              </div>
              <div className="button-row">
                <button
                  className="secondary"
                  onClick={() =>
                    void perform(() =>
                      api.update(character.name, {
                        paused: character.state !== "paused",
                      }),
                    )
                  }
                >
                  {character.state === "paused" ? "Resume" : "Pause"}
                </button>
                <button
                  className="secondary"
                  onClick={() => void perform(() => api.avatar(character.name))}
                >
                  New avatar
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    void perform(async () => {
                      const exported = await api.exportCharacter(character.name);
                      const blob = new Blob([JSON.stringify(exported, null, 2)], {
                        type: "application/json",
                      });
                      const url = URL.createObjectURL(blob);
                      const link = document.createElement("a");
                      link.href = url;
                      link.download = `${character.name}.agent.json`;
                      link.click();
                      URL.revokeObjectURL(url);
                    })
                  }
                >
                  Export
                </button>
              </div>
              <label>
                Leave something behind
                <input
                  value={artifactTitle}
                  onChange={(event) => setArtifactTitle(event.target.value)}
                  maxLength={80}
                />
                <textarea
                  value={artifactBody}
                  onChange={(event) => setArtifactBody(event.target.value)}
                  placeholder="A note, sketch, or tiny object for the next visitor…"
                  rows={2}
                  maxLength={400}
                />
              </label>
              <button
                className="secondary wide"
                disabled={busy || artifactBody.trim().length < 2}
                onClick={() =>
                  void perform(async () => {
                    await api.leaveArtifact(character.name, {
                      kind: "note",
                      title: artifactTitle.trim() || "A small note",
                      body: artifactBody.trim(),
                    });
                    setArtifactBody("");
                  })
                }
              >
                Leave in the world
              </button>
              <button
                className="danger-link"
                onClick={() => {
                  if (
                    confirm(
                      `Delete ${character.name} and all of their memories?`,
                    )
                  )
                    void perform(async () => {
                      await api.remove(character.name);
                      onClose();
                    });
                }}
              >
                Delete character
              </button>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
            </section>
          </div>
        )}
      </div>
    </aside>
  );
}

function AuthModal({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result =
        mode === "sign-in"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ email, password, name });
      const authError = authErrorMessage(result);
      if (authError) throw new Error(authError);
      // The API derives ownership from the authenticated server session. A
      // session refresh also makes the viewer identity available immediately.
      await api.session().catch(() => undefined);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="modal auth-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-title"
      >
        <button className="icon-button close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <p className="eyebrow">A durable place in the world</p>
        <h2 id="auth-title">
          {mode === "sign-in" ? "Welcome back" : "Join Agent World"}
        </h2>
        <div className="segmented" aria-label="Authentication mode">
          <button
            className={mode === "sign-in" ? "active" : ""}
            onClick={() => setMode("sign-in")}
            type="button"
          >
            Sign in
          </button>
          <button
            className={mode === "sign-up" ? "active" : ""}
            onClick={() => setMode("sign-up")}
            type="button"
          >
            Create account
          </button>
        </div>
        <form onSubmit={submit}>
          {mode === "sign-up" && (
            <label>
              Your name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                minLength={2}
                maxLength={80}
                required
                autoFocus
                placeholder="Ada"
              />
            </label>
          )}
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoFocus={mode === "sign-in"}
              autoComplete="email"
              placeholder="you@example.com"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={8}
              required
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary wide" disabled={busy}>
            {busy ? "Checking the gate…" : mode === "sign-in" ? "Sign in" : "Create account"}
          </button>
        </form>
      </section>
    </div>
  );
}

function AdminModal({
  snapshot,
  onClose,
}: {
  snapshot: WorldSnapshot;
  onClose: () => void;
}) {
  const [details, setDetails] = useState<{
    liveMpp: boolean;
    queueDepth: number;
    costs: unknown[];
    inFlight: string[];
    reports?: AdminReport[];
    alerts?: unknown[];
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const refreshAdmin = () => {
    void api.admin().then((payload) =>
      setDetails({
        liveMpp: payload.liveMpp,
        queueDepth: payload.queueDepth,
        costs: payload.costs,
        inFlight: payload.inFlight,
        reports: payload.reports,
        alerts: payload.alerts,
      }),
    );
  };
  useEffect(() => {
    refreshAdmin();
  }, []);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="modal admin-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-title"
      >
        <button
          className="icon-button close"
          onClick={onClose}
          aria-label="Close world administration"
        >
          ×
        </button>
        <p className="eyebrow">Operator controls</p>
        <h2 id="admin-title">World administration</h2>
        <div className="metric-grid">
          <div>
            <span>Simulation</span>
            <strong>{snapshot.simulationPaused ? "Paused" : "Running"}</strong>
          </div>
          <div>
            <span>Agent mode</span>
            <strong>{details?.liveMpp ? "Live MPP" : "Deterministic"}</strong>
          </div>
          <div>
            <span>Queue</span>
            <strong>{details?.queueDepth ?? "—"}</strong>
          </div>
          <div>
            <span>In flight</span>
            <strong>{details?.inFlight.length ?? "—"}</strong>
          </div>
          <div>
            <span>Daily server spend</span>
            <strong>
              {formatUsd(snapshot.serverSpentTodayMicros)} /{" "}
              {formatUsd(snapshot.serverDailyBudgetMicros)}
            </strong>
          </div>
          <div>
            <span>Cost records</span>
            <strong>{details?.costs.length ?? "—"}</strong>
          </div>
        </div>
        <label className="world-budget-control">
          Global daily budget
          <div className="money-input">
            <span>$</span>
            <input
              key={snapshot.serverDailyBudgetMicros}
              type="number"
              min="0"
              max="50"
              step="0.05"
              defaultValue={(
                snapshot.serverDailyBudgetMicros / 1_000_000
              ).toFixed(2)}
              onBlur={(event) =>
                void api.updateWorld(
                  Math.round(Number(event.target.value) * 1_000_000),
                )
              }
            />
          </div>
          <small>Set to $0 to stop all budgeted agent work.</small>
        </label>
        <div className="button-row">
          <button
            className="primary"
            onClick={() => void api.pauseWorld(!snapshot.simulationPaused)}
          >
            {snapshot.simulationPaused ? "Resume world" : "Pause world"}
          </button>
          <button
            className="danger"
            onClick={() => {
              if (
                confirm(
                  "Reset the entire world? This deletes every character and memory.",
                )
              )
                void api.resetWorld().then(onClose);
            }}
          >
            Reset world
          </button>
        </div>
        {(details?.reports?.length || details?.alerts?.length) ? (
          <section className="admin-lists">
            {details?.alerts?.length ? (
              <div>
                <h3>Alerts</h3>
                <ul>
                  {details.alerts.slice(0, 6).map((alert) => (
                    <li key={String((alert as { id?: string }).id)}>
                      {String((alert as { summary?: string }).summary ?? "")}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {details?.reports?.length ? (
              <div>
                <h3>Reports</h3>
                <ul>
                  {details.reports.slice(0, 8).map((item) => (
                    <li key={String(item.id)}>
                      <span>
                        {item.status}: {item.reason}
                      </span>
                      {item.status === "open" && item.id ? (
                        <span className="button-row">
                          <button
                            className="secondary"
                            disabled={busyId === item.id}
                            onClick={() => {
                              setBusyId(item.id ?? null);
                              void api
                                .resolveReport(item.id!)
                                .then(refreshAdmin)
                                .finally(() => setBusyId(null));
                            }}
                          >
                            Resolve
                          </button>
                          {item.characterId ? (
                            <button
                              className="danger"
                              disabled={busyId === item.id}
                              onClick={() => {
                                setBusyId(item.id ?? null);
                                void api
                                  .muteCharacter(item.characterId!, true)
                                  .then(refreshAdmin)
                                  .finally(() => setBusyId(null));
                              }}
                            >
                              Mute
                            </button>
                          ) : null}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ) : null}
      </section>
    </div>
  );
}

export function App() {
  const { snapshot, viewer, connected, refresh } = useWorld();
  const { user, isPending: authPending } = useAuth();
  const [modal, setModal] = useState<Modal | "auth">(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    snapshot?.characters.find((character) => character.id === selectedId) ??
    null;
  const ownedIds =
    viewer?.characterIds ??
    (viewer?.characterId ? [viewer.characterId] : []);
  const ownedCharacters =
    snapshot?.characters.filter((character) =>
      ownedIds.includes(character.id),
    ) ?? [];
  const recentEvents = useMemo(
    () => snapshot?.events.slice(0, 14) ?? [],
    [snapshot],
  );
  const artifacts = snapshot?.artifacts ?? [];
  const worldSpendPercent = snapshot
    ? snapshot.serverDailyBudgetMicros > 0
      ? Math.min(
          100,
          (snapshot.serverSpentTodayMicros / snapshot.serverDailyBudgetMicros) *
            100,
        )
      : 0
    : 0;
  const select = useCallback((id: string) => setSelectedId(id), []);

  const openCreate = () => {
    if (!user) setModal("auth");
    else if (ownedCharacters.length >= MAX_CHARACTERS_PER_USER)
      setSelectedId(ownedCharacters[0]?.id ?? null);
    else setModal("create");
  };

  const signOut = async () => {
    await authClient.signOut();
    await refresh();
    setSelectedId(null);
  };

  if (!snapshot)
    return (
      <main className="loading">
        <div className="loading-mark">AW</div>
        <h1>Opening Agent World…</h1>
        <p>Connecting to the shared world.</p>
      </main>
    );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">AW</div>
          <div>
            <h1>Agent World</h1>
            <p>They keep living when you leave.</p>
          </div>
        </div>
        <div className="header-actions">
          <div className={`connection ${connected ? "online" : ""}`}>
            <span />
            {connected ? "World live" : "Reconnecting"}
          </div>
          <div className="viewer-count">
            {snapshot.connectedViewers} watching · {snapshot.characters.length}{" "}
            living here
          </div>
          {viewer?.isAdmin && (
            <button
              className="world-spend"
              onClick={() => setModal("admin")}
              aria-label={`World spend ${formatUsd(snapshot.serverSpentTodayMicros)} of ${formatUsd(snapshot.serverDailyBudgetMicros)} daily budget. Open world administration.`}
              title={`World spend: ${formatUsd(snapshot.serverSpentTodayMicros)} of ${formatUsd(snapshot.serverDailyBudgetMicros)}`}
            >
              <span
                className="world-spend-ring"
                style={{
                  background: `conic-gradient(#4e9470 ${worldSpendPercent}%, #e1d5bd 0)`,
                }}
              >
                <span>$</span>
              </span>
            </button>
          )}
          {authPending ? (
            <span className="auth-label">Checking session…</span>
          ) : user ? (
            <>
              {ownedCharacters.map((character) => (
                <button
                  key={character.id}
                  className="owner-chip"
                  onClick={() => setSelectedId(character.id)}
                >
                  <span style={{ background: character.avatarColor }} />
                  {character.name}
                </button>
              ))}
              {ownedCharacters.length < MAX_CHARACTERS_PER_USER && (
                <button className="primary" onClick={openCreate}>
                  {ownedCharacters.length ? "Add character" : "Create a character"}
                </button>
              )}
              <button className="secondary auth-user" onClick={() => void signOut()}>
                {user.name || user.email} · Sign out
              </button>
            </>
          ) : (
            <button className="secondary" onClick={() => setModal("auth")}>
              Sign in
            </button>
          )}
        </div>
      </header>
      <main className="main-grid">
        <section className="world-panel">
          <div className="world-meta">
            <div>
              <span className="world-dot" /> Shared world
            </div>
            <p>Click anyone to see what they're thinking and remembering.</p>
          </div>
          <Suspense fallback={<div className="world-loading">Opening the world…</div>}>
            <WorldCanvas
              snapshot={snapshot}
              selectedId={selectedId}
              onSelect={select}
            />
          </Suspense>
          {!snapshot.characters.length && (
            <div className="empty-world">
              <div className="empty-orb">✦</div>
              <h2>The world is quiet—for now.</h2>
              <p>
                {snapshot.inviteOnly
                  ? "Watch the plaza while invites are closed. Operators will open character creation when the world is ready."
                  : "Be the first character to step into Sunbeam Plaza. Anyone else on this server will see you arrive."}
              </p>
              {snapshot.inviteOnly && !user ? (
                <button className="secondary" onClick={() => setModal("auth")}>
                  Sign in
                </button>
              ) : (
                <button className="primary" onClick={openCreate}>
                  Create the first character
                </button>
              )}
            </div>
          )}
          {snapshot.simulationPaused && (
            <div className="paused-banner">World paused by administrator</div>
          )}
          {selected && (
            <CharacterInspector
              key={selected.id}
              character={selected}
              ownedCharacterIds={ownedIds}
              onClose={() => setSelectedId(null)}
            />
          )}
        </section>
        <aside className="activity-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Public record</p>
              <h2>What's happening</h2>
            </div>
            <span className="event-count">latest 100</span>
          </div>
          {artifacts.length > 0 && (
            <ul className="artifact-list">
              {artifacts.slice(0, 6).map((artifact) => (
                <li key={artifact.id}>
                  <strong>{artifact.title}</strong>
                  <span>
                    {artifact.characterName ?? "someone"} · {artifact.locationId}
                  </span>
                  <p>{artifact.body}</p>
                </li>
              ))}
            </ul>
          )}
          {recentEvents.length ? (
            <ol className="event-list">
              {recentEvents.map((item) => (
                <li key={item.id} className={`event ${item.kind}`}>
                  <span className="event-symbol">
                    {item.kind === "conversation"
                      ? "☵"
                      : item.kind === "tool"
                        ? "⌁"
                        : item.kind === "memory"
                          ? "✦"
                          : item.kind === "arrival"
                            ? "→"
                            : "·"}
                  </span>
                  <div>
                    <p>{item.summary}</p>
                    {item.detail &&
                      !item.detail.startsWith("conversation:") && (
                        <details>
                          <summary>See details</summary>
                          <pre>{item.detail}</pre>
                        </details>
                      )}
                    <time>
                      {new Date(item.createdAt).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="activity-empty">
              <span>☁</span>
              <p>
                Actions, conversations, discoveries, and memories will appear
                here.
              </p>
            </div>
          )}
        </aside>
      </main>
      {modal === "create" && (
        <CreateModal
          onClose={() => setModal(null)}
          onCreated={() => void refresh()}
        />
      )}
      {modal === "auth" && (
        <AuthModal
          onClose={() => {
            setModal(null);
            void refresh();
          }}
        />
      )}
      {modal === "admin" && (
        <AdminModal snapshot={snapshot} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
