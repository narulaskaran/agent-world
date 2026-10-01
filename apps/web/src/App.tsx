import { Suspense, lazy, useCallback, useMemo, useState } from "react";
import { formatUsd } from "@agent-world/shared/world";
import { api } from "./api";
import { brainHint, brainLabel } from "./brain";
import { ActivityFeed } from "./components/ActivityFeed";
import { AdminModal } from "./components/AdminModal";
import { CreateModal } from "./components/CreateModal";
import { Inspector } from "./components/Inspector";
import { RecapCard, useRecap } from "./components/RecapCard";
import { PUBLIC_RECORD_LIMIT } from "./public-record";
import { useWorld } from "./ws";

const WorldCanvas = lazy(() =>
  import("./game/WorldCanvas").then((module) => ({
    default: module.WorldCanvas,
  })),
);

type Modal = "create" | "admin" | null;

/** More characters than this collapse into a "+N" menu in the header. */
const MAX_HEADER_CHIPS = 4;
/** Failed reconnects before telling the viewer the server is not running. */
const UNREACHABLE_AFTER = 2;

export function App() {
  const { snapshot, connected, failedAttempts } = useWorld();
  const [modal, setModal] = useState<Modal>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [seedError, setSeedError] = useState("");
  const [recap, dismissRecap] = useRecap();
  const select = useCallback((id: string | null) => setSelectedId(id), []);
  const selectAndClose = useCallback((id: string) => {
    setSelectedId(id);
    setRecordOpen(false);
  }, []);
  const selected =
    snapshot?.characters.find((character) => character.id === selectedId) ??
    null;
  const recentEvents = useMemo(
    () => snapshot?.events.slice(0, PUBLIC_RECORD_LIMIT) ?? [],
    [snapshot],
  );
  const unreachable = !connected && failedAttempts >= UNREACHABLE_AFTER;

  if (!snapshot)
    return (
      <main className="loading">
        <div className="loading-mark">AW</div>
        {unreachable ? (
          <>
            <h1>Can't reach Agent World</h1>
            <p>
              The local server isn't answering. Start it with{" "}
              <code>pnpm start</code>, then this page reconnects on its own.
            </p>
          </>
        ) : (
          <>
            <h1>Opening Agent World…</h1>
            <p>Connecting to your world.</p>
          </>
        )}
      </main>
    );

  const { brain } = snapshot;
  const worldSpendPercent =
    snapshot.serverDailyBudgetMicros > 0
      ? Math.min(
          100,
          (snapshot.serverSpentTodayMicros / snapshot.serverDailyBudgetMicros) *
            100,
        )
      : 0;
  const chips = snapshot.characters.slice(0, MAX_HEADER_CHIPS);
  const overflow = snapshot.characters.slice(MAX_HEADER_CHIPS);

  const seed = async () => {
    setSeeding(true);
    setSeedError("");
    try {
      await api.seed();
    } catch (caught) {
      setSeedError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSeeding(false);
    }
  };

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
              {connected
                ? "World live"
                : unreachable
                  ? "Server unreachable"
                  : "Reconnecting"}
            </div>
            <div className="world-stats">
              {snapshot.characters.length}{" "}
              {snapshot.characters.length === 1 ? "resident" : "residents"}
              {snapshot.decisionScale !== 1
                ? ` · ${snapshot.decisionScale}× speed`
                : ""}
            </div>
          </div>
          <button
            className={`brain-chip ${brain.budgeted ? "paid" : "keyless"}`}
            onClick={() => setModal("admin")}
            title={brainHint(brain)}
            aria-label={`${brainLabel(brain)}. ${brainHint(brain)} Open world settings.`}
          >
            {brainLabel(brain)}
          </button>
          {brain.budgeted && (
            <button
              className="world-spend"
              onClick={() => setModal("admin")}
              aria-label={`World spend ${formatUsd(snapshot.serverSpentTodayMicros)} of ${formatUsd(snapshot.serverDailyBudgetMicros)} daily budget. Open world settings.`}
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
          {chips.map((character) => (
            <button
              key={character.id}
              className={`owner-chip${character.id === selectedId ? " selected" : ""}`}
              onClick={() => setSelectedId(character.id)}
              title={character.name}
            >
              <span style={{ background: character.avatarColor }} />
              <span className="owner-chip-name">{character.name}</span>
            </button>
          ))}
          {overflow.length > 0 && (
            <details className="chip-overflow">
              <summary aria-label={`${overflow.length} more characters`}>
                +{overflow.length}
              </summary>
              <div className="chip-overflow-menu">
                {overflow.map((character) => (
                  <button
                    key={character.id}
                    className="owner-chip"
                    onClick={(event) => {
                      setSelectedId(character.id);
                      event.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                    }}
                  >
                    <span style={{ background: character.avatarColor }} />
                    <span className="owner-chip-name">{character.name}</span>
                  </button>
                ))}
              </div>
            </details>
          )}
          <button className="primary" onClick={() => setModal("create")}>
            {snapshot.characters.length
              ? "Add character"
              : "Create a character"}
          </button>
        </div>
      </header>
      {!connected && (
        <div className="connection-banner" role="status">
          {unreachable
            ? "The local server stopped answering. Showing the last known state; start it again with pnpm start."
            : "Reconnecting to the world…"}
        </div>
      )}
      <main className="main-grid">
        <section className="world-panel">
          <div className="world-meta">
            <div>
              <span className="world-dot" /> Local world
            </div>
            <p>
              {snapshot.characters.length
                ? "Click anyone to follow them and see what they're thinking."
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
                <p>
                  Invite three starter characters to see the world come alive,
                  or create your own.
                </p>
                <div className="button-row">
                  <button
                    className="primary"
                    disabled={seeding}
                    onClick={() => void seed()}
                  >
                    {seeding ? "Inviting…" : "Add a starter cast"}
                  </button>
                  <button
                    className="secondary"
                    onClick={() => setModal("create")}
                  >
                    Create my own
                  </button>
                </div>
                {seedError && (
                  <p className="form-error" role="alert">
                    {seedError}
                  </p>
                )}
              </div>
            </div>
          )}
          {recap && !selected && (
            <RecapCard
              recap={recap}
              characters={snapshot.characters}
              onSelect={selectAndClose}
              onDismiss={dismissRecap}
            />
          )}
          {snapshot.simulationPaused && (
            <div className="paused-banner">World paused</div>
          )}
          <button
            type="button"
            className="record-fab"
            aria-controls="activity"
            aria-expanded={recordOpen}
            onClick={() => setRecordOpen(true)}
          >
            Activity
          </button>
          {selected && (
            <Inspector
              key={selected.id}
              character={selected}
              brain={brain}
              escapeEnabled={modal === null}
              onSelect={setSelectedId}
              onClose={() => setSelectedId(null)}
            />
          )}
        </section>
        <aside
          className={`activity-panel${recordOpen ? " sheet-open" : ""}`}
          id="activity"
        >
          <button
            type="button"
            className="icon-button close record-sheet-close"
            onClick={() => setRecordOpen(false)}
            aria-label="Close activity"
          >
            ×
          </button>
          <ActivityFeed
            events={recentEvents}
            artifacts={snapshot.artifacts}
            characters={snapshot.characters}
            onSelect={selectAndClose}
          />
        </aside>
      </main>
      {recordOpen && (
        <button
          type="button"
          className="record-sheet-backdrop"
          aria-label="Dismiss activity"
          onClick={() => setRecordOpen(false)}
        />
      )}
      {modal === "create" && (
        <CreateModal budgeted={brain.budgeted} onClose={() => setModal(null)} />
      )}
      {modal === "admin" && (
        <AdminModal snapshot={snapshot} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
