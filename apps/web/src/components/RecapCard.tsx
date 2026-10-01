import { useEffect, useState } from "react";
import type { PublicCharacter, WorldRecap } from "@agent-world/shared/world";
import { api } from "../api";
import {
  LAST_SEEN_KEY,
  RECAP_MIN_AWAY_MS,
  recapSentence,
  recapWorthShowing,
} from "../brain";
import { eventClock, shortenFeedSummary } from "../public-record";

const MARK_SEEN_MS = 30_000;

/** Fetches a recap when the viewer returns after a meaningful absence. */
export function useRecap(): [WorldRecap | null, () => void] {
  const [recap, setRecap] = useState<WorldRecap | null>(null);
  useEffect(() => {
    let cancelled = false;
    const storedSeen = () => Number(localStorage.getItem(LAST_SEEN_KEY)) || 0;
    const markSeen = () =>
      localStorage.setItem(LAST_SEEN_KEY, String(Date.now()));
    const maybeRecap = () => {
      const since = storedSeen();
      if (since && Date.now() - since >= RECAP_MIN_AWAY_MS)
        void api
          .recap(since)
          .then((result) => {
            if (!cancelled && recapWorthShowing(result)) setRecap(result);
          })
          .catch(() => {});
      markSeen();
    };
    maybeRecap();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") markSeen();
    }, MARK_SEEN_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") maybeRecap();
      else markSeen();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", markSeen);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", markSeen);
    };
  }, []);
  return [recap, () => setRecap(null)];
}

export function RecapCard({
  recap,
  characters,
  onSelect,
  onDismiss,
}: {
  recap: WorldRecap;
  characters: PublicCharacter[];
  onSelect: (id: string) => void;
  onDismiss: () => void;
}) {
  return (
    <section className="recap-card" aria-labelledby="recap-title">
      <button
        className="icon-button close"
        onClick={onDismiss}
        aria-label="Dismiss recap"
      >
        ×
      </button>
      <p className="eyebrow">Since {eventClock(recap.since)}</p>
      <h2 id="recap-title">While you were away</h2>
      <p>{recapSentence(recap)}</p>
      {recap.highlights.length > 0 && (
        <ul>
          {recap.highlights.slice(0, 4).map((event) => {
            const actor = characters.find(
              (character) => character.id === event.characterId,
            );
            return (
              <li key={event.id}>
                {actor ? (
                  <button
                    type="button"
                    className="name-link"
                    onClick={() => onSelect(actor.id)}
                  >
                    {shortenFeedSummary(event.summary)}
                  </button>
                ) : (
                  shortenFeedSummary(event.summary)
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
