import type { PublicCharacter } from "@agent-world/shared/world";
import { shortenFeedSummary, summarySegments } from "../public-record";

/** An event summary with each character name as a link to that character. */
export function LinkedSummary({
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
