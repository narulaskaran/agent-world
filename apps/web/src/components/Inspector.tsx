import { useEffect, useState } from "react";
import {
  MODEL_OPTIONS,
  formatUsd,
  locationName,
  relationshipTier,
  type BrainMode,
  type CharacterInspect,
  type PublicCharacter,
} from "@agent-world/shared/world";
import { api, assetUrl } from "../api";
import { useDismissOnEscape } from "../hooks";
import { microsToInput, parseUsdInput } from "../money";

/** Memories and relationships refresh at most this often while things change. */
const DETAIL_REFRESH_MS = 5_000;
const CLOSE_FRIEND_AFFINITY = 8;

export function Inspector({
  character,
  brain,
  escapeEnabled,
  onSelect,
  onClose,
}: {
  character: PublicCharacter;
  brain: BrainMode;
  escapeEnabled: boolean;
  onSelect: (id: string) => void;
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
  const [budgetText, setBudgetText] = useState(
    microsToInput(character.dailyBudgetMicros),
  );
  useDismissOnEscape(onClose, escapeEnabled);
  const budgeted = brain.budgeted;

  const refreshKey = Math.floor(character.updatedAt / DETAIL_REFRESH_MS);
  useEffect(() => {
    let cancelled = false;
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
  }, [character.id, refreshKey]);

  useEffect(() => {
    setBudgetText(microsToInput(character.dailyBudgetMicros));
  }, [character.dailyBudgetMicros]);

  const memories = detail?.memories ?? [];
  const relationships = detail?.relationships ?? [];
  const modelLabel =
    MODEL_OPTIONS.find((model) => model.id === character.model)?.label ??
    character.model;
  const place = character.locationId
    ? locationName(character.locationId)
    : "Between places";

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

  const saveBudget = () => {
    const micros = parseUsdInput(budgetText, { min: 0.05, max: 2 });
    if (micros === null) {
      setError("Daily budget must be between $0.05 and $2.00.");
      setBudgetText(microsToInput(character.dailyBudgetMicros));
      return;
    }
    if (micros === character.dailyBudgetMicros) return;
    void perform(() =>
      api.update(character.name, { dailyBudgetMicros: micros }),
    );
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
            <img src={assetUrl(character.avatarUrl)} alt="" />
          ) : (
            <span>• •</span>
          )}
        </div>
        <div className="character-heading-copy">
          <p className="eyebrow">
            {character.state} · {place}
          </p>
          <div className="character-name-line">
            <h2>{character.name}</h2>
            {budgeted && (
              <span className="budget-summary">
                Spent {formatUsd(character.spentTodayMicros)} of{" "}
                {formatUsd(character.dailyBudgetMicros)}
              </span>
            )}
          </div>
          <p className="model-label">
            {budgeted ? `${modelLabel} · ` : ""}
            Reputation {character.reputation}
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
            [
              "memory",
              `Memory${memories.length ? ` (${memories.length})` : ""}`,
            ],
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
              <p className="intent-card">
                {character.speech ? `“${character.speech}”` : character.intent}
              </p>
            </section>
            <section>
              <h3>Personality</h3>
              <p className="personality-copy">{character.personality}</p>
            </section>
            <section>
              <h3>
                Relationships <span>{relationships.length}</span>
              </h3>
              {relationships.length ? (
                relationships.map((relationship) => (
                  <div className="relationship" key={relationship.characterId}>
                    <div className="relationship-heading">
                      <button
                        type="button"
                        className="name-link"
                        onClick={() => onSelect(relationship.characterId)}
                      >
                        {relationship.characterName}
                      </button>
                      <span className="tier">
                        {relationshipTier(relationship.affinity)}
                      </span>
                    </div>
                    <div
                      className="affinity-bar"
                      role="meter"
                      aria-label={`Affinity with ${relationship.characterName}`}
                      aria-valuemin={0}
                      aria-valuemax={CLOSE_FRIEND_AFFINITY}
                      aria-valuenow={Math.min(
                        relationship.affinity,
                        CLOSE_FRIEND_AFFINITY,
                      )}
                    >
                      <span
                        style={{
                          width: `${Math.min(100, (relationship.affinity / CLOSE_FRIEND_AFFINITY) * 100)}%`,
                        }}
                      />
                    </div>
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
                    <li key={memory.id} className={`memory ${memory.kind}`}>
                      {memory.bullet}
                    </li>
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
                <span>Your controls</span>
                {budgeted && (
                  <span>
                    {formatUsd(
                      Math.max(
                        0,
                        character.dailyBudgetMicros -
                          character.spentTodayMicros,
                      ),
                    )}{" "}
                    left
                  </span>
                )}
              </div>
              <div className="segmented compact">
                <button
                  className={mode === "directive" ? "active" : ""}
                  aria-pressed={mode === "directive"}
                  onClick={() => setMode("directive")}
                >
                  Direct
                </button>
                <button
                  className={mode === "personality" ? "active" : ""}
                  aria-pressed={mode === "personality"}
                  onClick={() => setMode("personality")}
                >
                  Update character
                </button>
              </div>
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                aria-label={
                  mode === "directive"
                    ? `Direction for ${character.name}`
                    : `Personality update for ${character.name}`
                }
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
                {budgeted && (
                  <label>
                    Model
                    <select
                      value={character.model}
                      disabled={busy}
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
                )}
                <label>
                  Think every
                  <select
                    value={character.decisionIntervalSeconds}
                    disabled={busy}
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
                {budgeted && (
                  <label>
                    Daily budget
                    <div className="money-input">
                      <span>$</span>
                      <input
                        type="number"
                        min="0.05"
                        max="2"
                        step="0.05"
                        value={budgetText}
                        disabled={busy}
                        onChange={(event) => setBudgetText(event.target.value)}
                        onBlur={saveBudget}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") saveBudget();
                        }}
                      />
                    </div>
                  </label>
                )}
              </div>
              <div className="button-row">
                <button
                  className="secondary"
                  disabled={busy}
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
                {brain.paidTools && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void perform(() => api.avatar(character.name))
                    }
                  >
                    New avatar
                  </button>
                )}
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
