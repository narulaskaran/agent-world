import { createHash } from "node:crypto";
import type { WorldSnapshot } from "../../shared/src/index.js";

export const ifNoneMatchHits = (
  incoming: string | undefined,
  etag: string,
): boolean => {
  if (!incoming) return false;
  const wanted = incoming
    .split(",")
    .map((value) => value.trim().replace(/^W\//, ""));
  const normalized = etag.trim().replace(/^W\//, "");
  return wanted.includes("*") || wanted.includes(normalized);
};

export const worldSnapshotEtag = (
  snapshot: WorldSnapshot,
  viewerKey: string,
): string => {
  const fingerprint = {
    viewerKey,
    simulationPaused: snapshot.simulationPaused,
    inviteOnly: Boolean(snapshot.inviteOnly),
    connectedViewers: snapshot.connectedViewers,
    serverSpentTodayMicros: snapshot.serverSpentTodayMicros,
    serverDailyBudgetMicros: snapshot.serverDailyBudgetMicros,
    budgetDate: snapshot.budgetDate,
    characters: snapshot.characters.map((character) => ({
      id: character.id,
      name: character.name,
      personality: character.personality,
      model: character.model,
      state: character.state,
      targetX: character.targetX,
      targetY: character.targetY,
      intent: character.intent,
      speech: character.speech,
      avatarColor: character.avatarColor,
      toolActive: character.toolActive,
      reputation: character.reputation,
      locationId: character.locationId,
      updatedAt: character.updatedAt,
      memories: character.memories.map((memory) => memory.id),
      relationships: character.relationships.map(
        (row) => `${row.characterId}:${row.affinity}`,
      ),
    })),
    events: snapshot.events.map((event) => event.id),
    artifacts: snapshot.artifacts.map((artifact) => artifact.id),
  };
  const digest = createHash("sha1")
    .update(JSON.stringify(fingerprint))
    .digest("base64url");
  return `W/"${digest}"`;
};
