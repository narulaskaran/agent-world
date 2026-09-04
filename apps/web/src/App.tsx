import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type {
  PublicCharacter,
  ServerMessage,
  WorldSnapshot,
} from "@agent-world/shared";
import { MODEL_OPTIONS, formatUsd } from "@agent-world/shared";
import { API_URL, api } from "./api";
import { WorldCanvas } from "./game/WorldCanvas";

type Modal = "create" | "admin" | null;

function useWorld() {
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let stopped = false;
    let retry: number | undefined;
    let initial: number | undefined;
    let socket: WebSocket | undefined;
    const connect = () => {
      socket = new WebSocket(API_URL.replace(/^http/, "ws") + "/ws");
      socket.onopen = () => setConnected(true);
      socket.onmessage = (message) => {
        const parsed = JSON.parse(String(message.data)) as ServerMessage;
        if (parsed.type === "snapshot") setSnapshot(parsed.payload);
      };
      socket.onclose = () => {
        setConnected(false);
        if (!stopped) retry = window.setTimeout(connect, 1200);
      };
    };
    void api
      .state()
      .then(setSnapshot)
      .catch(() => {});
    // Let React Strict Mode discard its probe mount before opening a socket.
    initial = window.setTimeout(connect, 0);
    return () => {
      stopped = true;
      if (initial !== undefined) clearTimeout(initial);
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, []);

  return { snapshot, connected };
}

function CreateModal({
  snapshot,
  onClose,
  onOwned,
}: {
  snapshot: WorldSnapshot;
  onClose: () => void;
  onOwned: (name: string) => void;
}) {
  const [mode, setMode] = useState<"create" | "return">("create");
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
    if (mode === "return") {
      const match = snapshot.characters.find(
        (character) =>
          character.name.toLowerCase() === name.trim().toLowerCase(),
      );
      if (!match)
        return setError("No character with that name lives here yet.");
      onOwned(match.name);
      onClose();
      return;
    }
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
      onOwned(name.trim());
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
        <h2 id="create-title">
          {mode === "create" ? "Create your character" : "Welcome back"}
        </h2>
        <div className="segmented" aria-label="Character entry mode">
          <button
            className={mode === "create" ? "active" : ""}
            onClick={() => setMode("create")}
          >
            New character
          </button>
          <button
            className={mode === "return" ? "active" : ""}
            onClick={() => setMode("return")}
          >
            I already live here
          </button>
        </div>
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
          {mode === "create" && (
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
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary wide" disabled={busy}>
            {busy
              ? "Opening the gate…"
              : mode === "create"
                ? "Enter Agent World"
                : "Resume character"}
          </button>
        </form>
      </section>
    </div>
  );
}

function CharacterInspector({
  character,
  ownerName,
  onClose,
  onForget,
}: {
  character: PublicCharacter;
  ownerName: string | null;
  onClose: () => void;
  onForget: () => void;
}) {
  const owned = ownerName?.toLowerCase() === character.name.toLowerCase();
  const [tab, setTab] = useState<"overview" | "memory" | "controls">(
    "overview",
  );
  const [mode, setMode] = useState<"directive" | "personality">("directive");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
          <p className="model-label">{modelLabel}</p>
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

        {tab === "controls" && (
          <div className="inspector-pane" role="tabpanel">
            <section className="owner-panel">
              <div className="owner-title">
                <span>Local controls</span>
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
              </div>
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
                      if (owned) onForget();
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
  } | null>(null);
  useEffect(() => {
    void api.admin().then(setDetails);
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
        <p className="eyebrow">Local controls</p>
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
      </section>
    </div>
  );
}

export function App() {
  const { snapshot, connected } = useWorld();
  const [modal, setModal] = useState<Modal>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ownerName, setOwnerName] = useState<string | null>(() =>
    localStorage.getItem("agent-world-owner"),
  );
  const selected =
    snapshot?.characters.find((character) => character.id === selectedId) ??
    null;
  const owner =
    snapshot?.characters.find(
      (character) => character.name.toLowerCase() === ownerName?.toLowerCase(),
    ) ?? null;
  const recentEvents = useMemo(
    () => snapshot?.events.slice(0, 14) ?? [],
    [snapshot],
  );
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

  useEffect(() => {
    if (snapshot && ownerName && !owner) {
      localStorage.removeItem("agent-world-owner");
      setOwnerName(null);
    }
  }, [snapshot, ownerName, owner]);

  const own = (name: string) => {
    localStorage.setItem("agent-world-owner", name);
    setOwnerName(name);
  };
  const forget = () => {
    localStorage.removeItem("agent-world-owner");
    setOwnerName(null);
  };

  if (!snapshot)
    return (
      <main className="loading">
        <div className="loading-mark">AW</div>
        <h1>Opening Agent World…</h1>
        <p>Connecting to the local server.</p>
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
          {owner ? (
            <button
              className="owner-chip"
              onClick={() => setSelectedId(owner.id)}
            >
              <span style={{ background: owner.avatarColor }} />
              {owner.name}
            </button>
          ) : (
            <button className="primary" onClick={() => setModal("create")}>
              Create a character
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
          <WorldCanvas
            snapshot={snapshot}
            selectedId={selectedId}
            onSelect={select}
          />
          {!snapshot.characters.length && (
            <div className="empty-world">
              <div className="empty-orb">✦</div>
              <h2>The world is quiet—for now.</h2>
              <p>
                Be the first character to step into Sunbeam Plaza. Anyone else
                on this server will see you arrive.
              </p>
              <button className="primary" onClick={() => setModal("create")}>
                Create the first character
              </button>
            </div>
          )}
          {snapshot.simulationPaused && (
            <div className="paused-banner">World paused by administrator</div>
          )}
          {selected && (
            <CharacterInspector
              key={selected.id}
              character={selected}
              ownerName={ownerName}
              onClose={() => setSelectedId(null)}
              onForget={forget}
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
          snapshot={snapshot}
          onClose={() => setModal(null)}
          onOwned={own}
        />
      )}
      {modal === "admin" && (
        <AdminModal snapshot={snapshot} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
