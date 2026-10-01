import { useEffect, useState } from "react";
import { formatUsd, type WorldSnapshot } from "@agent-world/shared/world";
import { api, type AdminState } from "../api";
import { WORLD_SPEEDS, brainHint, brainLabel } from "../brain";
import { useDismissOnEscape, useFocusTrap } from "../hooks";
import { microsToInput, parseUsdInput } from "../money";

const ADMIN_REFRESH_MS = 5_000;

export function AdminModal({
  snapshot,
  onClose,
}: {
  snapshot: WorldSnapshot;
  onClose: () => void;
}) {
  const [details, setDetails] = useState<AdminState | null>(null);
  const [error, setError] = useState("");
  const [budgetText, setBudgetText] = useState(
    microsToInput(snapshot.serverDailyBudgetMicros),
  );
  const trap = useFocusTrap<HTMLElement>();
  useDismissOnEscape(onClose);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void api
        .admin()
        .then((payload) => {
          if (!cancelled) setDetails(payload);
        })
        .catch((caught) => {
          if (!cancelled)
            setError(caught instanceof Error ? caught.message : String(caught));
        });
    load();
    const timer = window.setInterval(load, ADMIN_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    setBudgetText(microsToInput(snapshot.serverDailyBudgetMicros));
  }, [snapshot.serverDailyBudgetMicros]);

  const perform = (action: () => Promise<unknown>) => {
    setError("");
    void action().catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
  };

  const saveBudget = () => {
    const micros = parseUsdInput(budgetText, { min: 0, max: 50 });
    if (micros === null) {
      setError("World budget must be between $0 and $50.");
      setBudgetText(microsToInput(snapshot.serverDailyBudgetMicros));
      return;
    }
    if (micros !== snapshot.serverDailyBudgetMicros)
      perform(() => api.updateWorld({ serverDailyBudgetMicros: micros }));
  };

  const speeds = WORLD_SPEEDS.includes(
    snapshot.decisionScale as (typeof WORLD_SPEEDS)[number],
  )
    ? WORLD_SPEEDS
    : [...WORLD_SPEEDS, snapshot.decisionScale].sort((a, b) => a - b);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        ref={trap}
        className="modal admin-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-title"
      >
        <button
          className="icon-button close"
          onClick={onClose}
          aria-label="Close world settings"
        >
          ×
        </button>
        <p className="eyebrow">Your world</p>
        <h2 id="admin-title">World settings</h2>
        <p className="brain-hint">
          <strong>{brainLabel(snapshot.brain)}.</strong>{" "}
          {brainHint(snapshot.brain)}
        </p>
        <div className="metric-grid">
          <div>
            <span>Simulation</span>
            <strong>{snapshot.simulationPaused ? "Paused" : "Running"}</strong>
          </div>
          <div>
            <span>Queued work</span>
            <strong>{details?.queueDepth ?? "—"}</strong>
          </div>
          <div>
            <span>Thinking now</span>
            <strong>{details?.inFlight.length ?? "—"}</strong>
          </div>
          {snapshot.brain.budgeted && (
            <div>
              <span>Spent today</span>
              <strong>
                {formatUsd(snapshot.serverSpentTodayMicros)} /{" "}
                {formatUsd(snapshot.serverDailyBudgetMicros)}
              </strong>
            </div>
          )}
        </div>
        {details?.lastFailure && (
          <p className="provider-failure">
            Last provider problem ({details.lastFailure.provider},{" "}
            {new Date(details.lastFailure.at).toLocaleTimeString()}):{" "}
            {details.lastFailure.message}. Characters used the keyless brain
            instead.
          </p>
        )}
        <div className="admin-controls">
          <label>
            World speed
            <select
              value={snapshot.decisionScale}
              onChange={(event) =>
                perform(() =>
                  api.updateWorld({
                    decisionScale: Number(event.target.value),
                  }),
                )
              }
            >
              {speeds.map((speed) => (
                <option key={speed} value={speed}>
                  {speed}×
                </option>
              ))}
            </select>
            <small>
              Faster worlds think and talk more often
              {snapshot.brain.budgeted ? ", and spend faster" : ""}.
            </small>
          </label>
          {snapshot.brain.budgeted && (
            <label className="world-budget-control">
              Daily budget for the whole world
              <div className="money-input">
                <span>$</span>
                <input
                  type="number"
                  min="0"
                  max="50"
                  step="0.05"
                  value={budgetText}
                  onChange={(event) => setBudgetText(event.target.value)}
                  onBlur={saveBudget}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") saveBudget();
                  }}
                />
              </div>
              <small>Set to $0 to stop all paid agent work.</small>
            </label>
          )}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="button-row">
          <button
            className="primary"
            onClick={() =>
              perform(() => api.pauseWorld(!snapshot.simulationPaused))
            }
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
                perform(() => api.resetWorld().then(onClose));
            }}
          >
            Reset world
          </button>
        </div>
      </section>
    </div>
  );
}
