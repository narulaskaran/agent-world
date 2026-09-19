import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  MODEL_OPTIONS,
  formatUsd,
  type CharacterInspect,
  type PublicCharacter,
  type WorldSnapshot,
} from "@agent-world/shared";
import { api } from "./api";
import { useWorld } from "./ws";
import {
  PUBLIC_RECORD_LIMIT,
  eventDetail,
  eventDetailsLabel,
  shortDisplayId,
  shortenFeedSummary,
} from "./public-record";

const WorldCanvas = lazy(() =>
  import("./game/WorldCanvas").then((module) => ({
    default: module.WorldCanvas,
  })),
);

type Modal = "create" | "admin" | null;

function useDismissOnEscape(onClose: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
}

function CreateModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [personality, setPersonality] = useState("");
  const [model, setModel] = useState<string>(MODEL_OPTIONS[0].id);
  const [budget, setBudget] = useState("0.50");
  const [mission, setMission] = useState<"meet" | "explore">("meet");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useDismissOnEscape(onClose);

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
              This shapes how your character speaks, explores, and remembers.
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
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
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
  onClose,
}: {
  character: PublicCharacter;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"overview" | "memory" | "controls">(
    "overview",
  );
  const [mode, setMode] = useState<"directive" | "personality">("directive");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<CharacterInspect | null>(null);
  const personality = detail?.personality ?? character.personality;
  const memories = detail?.memories ?? character.memories ?? [];
  const relationships = detail?.relationships ?? character.relationships ?? [];
  const spentTodayMicros =
    detail?.spentTodayMicros ?? character.spentTodayMicros ?? 0;
  const dailyBudgetMicros =
    detail?.dailyBudgetMicros ?? character.dailyBudgetMicros ?? 0;
  const modelId = detail?.model ?? character.model;
  const decisionIntervalSeconds =
    detail?.decisionIntervalSeconds ?? character.decisionIntervalSeconds ?? 60;
  const modelLabel =
    MODEL_OPTIONS.find((model) => model.id === modelId)?.label ??
    modelId ??
    "Unknown model";

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError("");
    void api
      .inspect(character.id)
      .then((payload) => {
        if (!cancelled) setDetail(payload.character);
      })
      .catch((caught) => {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [character.id]);

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
              Spent {formatUsd(spentTodayMicros)} of{" "}
              {formatUsd(dailyBudgetMicros)}
            </span>
          </div>
          <p className="model-label">
            {modelLabel}
            {character.locationId ? ` · ${character.locationId}` : ""}
          </p>
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
        {error && tab !== "controls" ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {tab === "overview" && (
          <div className="inspector-pane" role="tabpanel">
            <section>
              <h3>Right now</h3>
              <p className="intent-card">{character.intent}</p>
            </section>
            <section>
              <h3>Personality</h3>
              <p>
                {personality ??
                  (detail || error
                    ? "No personality on record."
                    : "Loading details…")}
              </p>
            </section>
            <section>
              <h3>
                Relationships <span>{relationships.length}</span>
              </h3>
              {relationships.length ? (
                relationships.map((relationship) => (
                  <div className="relationship" key={relationship.characterId}>
                    <strong>{relationship.characterName}</strong>
                    <p>{relationship.impression}</p>
                  </div>
                ))
              ) : (
                <p className="empty-copy">
                  {detail
                    ? "Hasn't gotten to know anyone yet."
                    : "Loading details…"}
                </p>
              )}
            </section>
          </div>
        )}

        {tab === "memory" && (
          <div className="inspector-pane" role="tabpanel">
            <section>
              <h3>What {character.name} remembers</h3>
              {memories.length ? (
                <ul className="memory-list">
                  {memories.map((memory) => (
                    <li key={memory.id}>{memory.bullet}</li>
                  ))}
                </ul>
              ) : (
                <p className="empty-copy">
                  {detail ? "No lasting memories yet." : "Loading details…"}
                </p>
              )}
            </section>
          </div>
        )}

        {tab === "controls" && (
          <div className="inspector-pane" role="tabpanel">
            <section className="owner-panel">
              <div className="owner-title">
                <span>Owner controls</span>
                <span>
                  {formatUsd(dailyBudgetMicros - spentTodayMicros)} left
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
                    value={modelId ?? MODEL_OPTIONS[0].id}
                    disabled={busy || !detail}
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
                    value={decisionIntervalSeconds}
                    disabled={busy || !detail}
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
                      key={dailyBudgetMicros}
                      type="number"
                      min="0.05"
                      max="2"
                      step="0.05"
                      defaultValue={
                        dailyBudgetMicros
                          ? (dailyBudgetMicros / 1_000_000).toFixed(2)
                          : ""
                      }
                      disabled={busy || !detail}
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
  useDismissOnEscape(onClose);
  useEffect(() => {
    void api.admin().then((payload) =>
      setDetails({
        liveMpp: payload.liveMpp,
        queueDepth: payload.queueDepth,
        costs: payload.costs,
        inFlight: payload.inFlight,
      }),
    );
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
      </section>
    </div>
  );
}

export function App() {
  const { snapshot, connected } = useWorld();
  const [modal, setModal] = useState<Modal>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    snapshot?.characters.find((character) => character.id === selectedId) ??
    null;
  const recentEvents = useMemo(
    () => snapshot?.events.slice(0, PUBLIC_RECORD_LIMIT) ?? [],
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
  const [recordOpen, setRecordOpen] = useState(false);
  const select = useCallback((id: string | null) => setSelectedId(id), []);

  if (!snapshot)
    return (
      <main className="loading">
        <div className="loading-mark">AW</div>
        <h1>Opening Agent World…</h1>
        <p>Connecting to your world.</p>
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
          <div className="header-status">
            <div className={`connection ${connected ? "online" : ""}`}>
              <span />
              {connected ? "World live" : "Reconnecting"}
            </div>
            <div className="viewer-count">
              {snapshot.connectedViewers} watching ·{" "}
              {snapshot.characters.length} living
              <span className="viewer-count-here"> here</span>
            </div>
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
          {snapshot.characters.map((character) => (
            <button
              key={character.id}
              className="owner-chip"
              onClick={() => setSelectedId(character.id)}
            >
              <span style={{ background: character.avatarColor }} />
              {character.name}
            </button>
          ))}
          <button className="primary" onClick={() => setModal("create")}>
            {snapshot.characters.length
              ? "Add character"
              : "Create a character"}
          </button>
        </div>
      </header>
      <main className="main-grid">
        <section className="world-panel">
          <div className="world-meta">
            <div>
              <span className="world-dot" /> Local world
            </div>
            <p>
              {snapshot.characters.length
                ? "Click anyone to see what they're thinking and remembering."
                : "Nobody is here yet."}
            </p>
          </div>
          <Suspense
            fallback={<div className="world-loading">Opening the world…</div>}
          >
            <WorldCanvas
              snapshot={snapshot}
              selectedId={selectedId}
              onSelect={select}
            />
          </Suspense>
          {!snapshot.characters.length && (
            <div className="empty-world">
              <div className="empty-world-copy">
                <div className="empty-orb">✦</div>
                <h2>The world is quiet—for now.</h2>
                <p>Be the first character to step into Sunbeam Plaza.</p>
                <button className="primary" onClick={() => setModal("create")}>
                  Create the first character
                </button>
              </div>
            </div>
          )}
          {snapshot.simulationPaused && (
            <div className="paused-banner">World paused by administrator</div>
          )}
          <button
            type="button"
            className="record-fab"
            aria-controls="public-record"
            aria-expanded={recordOpen}
            onClick={() => setRecordOpen(true)}
          >
            Public record
          </button>
          {selected && (
            <CharacterInspector
              key={selected.id}
              character={selected}
              onClose={() => setSelectedId(null)}
            />
          )}
        </section>
        <aside
          className={`activity-panel${recordOpen ? " sheet-open" : ""}`}
          id="public-record"
        >
          <button
            type="button"
            className="icon-button close record-sheet-close"
            onClick={() => setRecordOpen(false)}
            aria-label="Close public record"
          >
            ×
          </button>
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Public record</p>
              <h2>What's happening</h2>
            </div>
            <span className="event-count">latest 100</span>
          </div>
          {artifacts.length > 0 && (
            <ul className="artifact-list">
              {artifacts.slice(0, 6).map((artifact) => {
                const actor = artifact.characterName ?? "someone";
                const actorShort = shortDisplayId(actor);
                const displayTitle = shortenFeedSummary(artifact.title);
                return (
                  <li key={artifact.id}>
                    <strong
                      title={
                        displayTitle !== artifact.title
                          ? artifact.title
                          : undefined
                      }
                    >
                      {displayTitle}
                    </strong>
                    <span title={actor !== actorShort ? actor : undefined}>
                      {actorShort} · {artifact.locationId}
                    </span>
                    <p>{artifact.body}</p>
                  </li>
                );
              })}
            </ul>
          )}
          {recentEvents.length ? (
            <ol className="event-list">
              {recentEvents.map((item) => {
                const detail = eventDetail(item.detail);
                const displaySummary = shortenFeedSummary(item.summary);
                return (
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
                    <div className="event-copy">
                      <div className="event-headline">
                        <p
                          title={
                            displaySummary !== item.summary
                              ? item.summary
                              : undefined
                          }
                        >
                          {displaySummary}
                        </p>
                        <time>
                          {new Date(item.createdAt).toLocaleTimeString([], {
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                      {detail && (
                        <details>
                          <summary
                            aria-label={eventDetailsLabel(item.summary, {
                              createdAt: item.createdAt,
                              id: item.id,
                            })}
                          >
                            See details
                          </summary>
                          <pre>{detail}</pre>
                        </details>
                      )}
                    </div>
                  </li>
                );
              })}
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
      {recordOpen && (
        <button
          type="button"
          className="record-sheet-backdrop"
          aria-label="Dismiss public record"
          onClick={() => setRecordOpen(false)}
        />
      )}
      {modal === "create" && <CreateModal onClose={() => setModal(null)} />}
      {modal === "admin" && (
        <AdminModal snapshot={snapshot} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
