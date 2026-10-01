import { useState, type FormEvent } from "react";
import { MODEL_OPTIONS } from "@agent-world/shared/world";
import { api } from "../api";
import { useDismissOnEscape, useFocusTrap } from "../hooks";
import { parseUsdInput } from "../money";

export function CreateModal({
  budgeted,
  onClose,
}: {
  budgeted: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [personality, setPersonality] = useState("");
  const [model, setModel] = useState<string>(MODEL_OPTIONS[0].id);
  const [budget, setBudget] = useState("0.50");
  const [mission, setMission] = useState<"meet" | "explore">("meet");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trap = useFocusTrap<HTMLElement>();
  useDismissOnEscape(onClose);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const dailyBudgetMicros = budgeted
      ? parseUsdInput(budget, { min: 0.05, max: 2 })
      : 500_000;
    if (dailyBudgetMicros === null) {
      setError("Daily budget must be between $0.05 and $2.00.");
      return;
    }
    setBusy(true);
    try {
      await api.create({
        name: name.trim(),
        personality: personality.trim(),
        model,
        dailyBudgetMicros,
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
        ref={trap}
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
        <p className="eyebrow">A new resident</p>
        <h2 id="create-title">Create a character</h2>
        <form onSubmit={submit}>
          <label>
            Name
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
          {budgeted && (
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
          )}
          <fieldset>
            <legend>First adventure</legend>
            <div className="mission-grid">
              <button
                type="button"
                className={`mission ${mission === "meet" ? "selected" : ""}`}
                aria-pressed={mission === "meet"}
                onClick={() => setMission("meet")}
              >
                <span className="mission-icon">☕</span>
                <strong>Meet someone</strong>
                <small>Find another character and start a conversation.</small>
              </button>
              <button
                type="button"
                className={`mission ${mission === "explore" ? "selected" : ""}`}
                aria-pressed={mission === "explore"}
                onClick={() => setMission("explore")}
              >
                <span className="mission-icon">🧭</span>
                <strong>Explore the world</strong>
                <small>
                  Wander the plaza, park, café, library and Tinker Shed.
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
