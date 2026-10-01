import { useMemo, useState } from "react";
import {
  locationName,
  placeInSentence,
  type PublicCharacter,
  type WorldArtifact,
  type WorldEvent,
} from "@agent-world/shared/world";
import {
  conversationLine,
  eventClock,
  eventDetail,
  eventDetailsLabel,
  eventInvolves,
  shortenFeedSummary,
  summarySegments,
  threadEvents,
} from "../public-record";

const EVENT_SYMBOLS: Partial<Record<WorldEvent["kind"], string>> = {
  conversation: "☵",
  tool: "⌁",
  memory: "✦",
  arrival: "→",
  artifact: "✎",
  owner: "✋",
};

function Summary({
  text,
  characters,
  onSelect,
}: {
  text: string;
  characters: PublicCharacter[];
  onSelect: (id: string) => void;
}) {
  return (
    <>
      {summarySegments(shortenFeedSummary(text), characters).map(
        (segment, index) =>
          segment.characterId ? (
            <button
              key={index}
              type="button"
              className="name-link"
              onClick={() => onSelect(segment.characterId!)}
            >
              {segment.text}
            </button>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
      )}
    </>
  );
}

function EventRow({
  event,
  characters,
  onSelect,
}: {
  event: WorldEvent;
  characters: PublicCharacter[];
  onSelect: (id: string) => void;
}) {
  const detail = eventDetail(event.detail);
  return (
    <li className={`event ${event.kind}`}>
      <span className="event-symbol">{EVENT_SYMBOLS[event.kind] ?? "·"}</span>
      <div className="event-copy">
        <div className="event-headline">
          <p title={event.summary}>
            <Summary
              text={event.summary}
              characters={characters}
              onSelect={onSelect}
            />
          </p>
          <time>{eventClock(event.createdAt)}</time>
        </div>
        {detail && (
          <details>
            <summary
              aria-label={eventDetailsLabel(event.summary, {
                createdAt: event.createdAt,
                id: event.id,
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
}

function ConversationThread({
  events,
  characters,
  onSelect,
}: {
  events: WorldEvent[];
  characters: PublicCharacter[];
  onSelect: (id: string) => void;
}) {
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const lines = events.flatMap((event) => {
    const line = conversationLine(event);
    return line ? [{ ...line, id: event.id }] : [];
  });
  const finished = events.find((event) =>
    event.summary.endsWith("finished talking."),
  );
  const names = [first.characterId, first.targetCharacterId]
    .map((id) => characters.find((character) => character.id === id)?.name)
    .filter(Boolean)
    .join(" and ");
  const heading =
    names || `${first.characterName ?? "Someone"} and another character`;
  return (
    <li className="event conversation thread">
      <span className="event-symbol">☵</span>
      <div className="event-copy">
        <div className="event-headline">
          <p>
            <Summary
              text={`${heading} ${finished ? "talked" : "are talking"}`}
              characters={characters}
              onSelect={onSelect}
            />
            <span className="thread-count">
              {" "}
              ·{" "}
              {lines.length === 0
                ? "just started"
                : `${lines.length} ${lines.length === 1 ? "line" : "lines"}`}
            </span>
          </p>
          <time>{eventClock(last.createdAt)}</time>
        </div>
        {lines.length > 0 && (
          <details open={!finished}>
            <summary>{finished ? "Read conversation" : "Listening"}</summary>
            <ol className="thread-lines">
              {lines.map((line) => (
                <li key={line.id}>
                  <strong>{line.speaker}</strong> {line.text}
                </li>
              ))}
            </ol>
            {finished?.detail && (
              <p className="thread-end">Ended: {finished.detail}</p>
            )}
          </details>
        )}
      </div>
    </li>
  );
}

export function ActivityFeed({
  events,
  artifacts,
  characters,
  onSelect,
}: {
  events: WorldEvent[];
  artifacts: WorldArtifact[];
  characters: PublicCharacter[];
  onSelect: (id: string) => void;
}) {
  const [filterId, setFilterId] = useState("");
  const filterValid = characters.some((character) => character.id === filterId);
  const activeFilter = filterValid ? filterId : "";
  const items = useMemo(
    () =>
      threadEvents(
        activeFilter
          ? events.filter((event) => eventInvolves(event, activeFilter))
          : events,
      ),
    [events, activeFilter],
  );
  const shownArtifacts = (
    activeFilter
      ? artifacts.filter((artifact) => artifact.characterId === activeFilter)
      : artifacts
  ).slice(0, 4);

  return (
    <>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Activity</p>
          <h2>What's happening</h2>
        </div>
        {characters.length > 0 && (
          <label className="feed-filter">
            <span className="visually-hidden">Show activity for</span>
            <select
              value={activeFilter}
              onChange={(event) => setFilterId(event.target.value)}
            >
              <option value="">Everyone</option>
              {characters.map((character) => (
                <option key={character.id} value={character.id}>
                  {character.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {shownArtifacts.length > 0 && (
        <section className="artifact-shelf" aria-label="Things left behind">
          <h3>Left at {placeInSentence(locationName("workshop"))}</h3>
          <ul className="artifact-list">
            {shownArtifacts.map((artifact) => (
              <li key={artifact.id}>
                <strong>{artifact.title}</strong>
                <span>
                  {artifact.characterId ? (
                    <button
                      type="button"
                      className="name-link"
                      onClick={() => onSelect(artifact.characterId!)}
                    >
                      {artifact.characterName ?? "someone"}
                    </button>
                  ) : (
                    (artifact.characterName ?? "someone")
                  )}{" "}
                  · {eventClock(artifact.createdAt)}
                </span>
                <p>{artifact.body}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {items.length ? (
        <ol className="event-list">
          {items.map((item) =>
            item.type === "conversation" ? (
              <ConversationThread
                key={item.conversationId}
                events={item.events}
                characters={characters}
                onSelect={onSelect}
              />
            ) : (
              <EventRow
                key={item.event.id}
                event={item.event}
                characters={characters}
                onSelect={onSelect}
              />
            ),
          )}
        </ol>
      ) : (
        <div className="activity-empty">
          <span>☁</span>
          <p>
            {activeFilter
              ? "Nothing involving them yet."
              : "Actions, conversations, discoveries, and memories will appear here."}
          </p>
        </div>
      )}
    </>
  );
}
