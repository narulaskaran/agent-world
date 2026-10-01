import {
  LOCATION_DETAILS,
  WORLD_LOCATIONS,
  hashString,
  locationName,
  placeInSentence,
  type WorldLocationId,
} from "@agent-world/shared";
import type {
  AgentContext,
  AgentDecision,
  ExtractedMemory,
} from "./services.js";

export type Random = () => number;

const pick = <T>(items: readonly T[], random: Random): T =>
  items[Math.floor(random() * items.length) % items.length]!;

const stablePick = <T>(items: readonly T[], seed: string): T =>
  items[hashString(seed) % items.length]!;

const FILLER_WORDS = new Set(["a", "an", "the", "very", "quite", "always"]);
const LINKING_VERBS = new Set(["is", "was", "seems", "feels", "am"]);

/** The leading adjective of a personality: "Restless maker who…" → "restless". */
export function leadingTrait(personality: string): string {
  const words = (personality.split(/[,.;\n]/)[0] ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const verb = words.findIndex((word) => LINKING_VERBS.has(word));
  const rest = verb >= 0 && verb < 3 ? words.slice(verb + 1) : words;
  const trait = rest
    .find((word) => !FILLER_WORDS.has(word))
    ?.replace(/[^\p{L}-]/gu, "");
  return trait || "curious";
}

const availableNearby = (context: AgentContext) =>
  context.nearby.filter(
    (person) =>
      person.state !== "talking" &&
      person.state !== "sleeping" &&
      person.state !== "paused",
  );

const mentionedLocation = (text: string): WorldLocationId | undefined => {
  const lower = text.toLowerCase();
  const aliases: Array<[WorldLocationId, string[]]> = [
    ["plaza", ["plaza", "fountain", "sunbeam"]],
    ["cafe", ["cafe", "café", "tiny cup", "coffee"]],
    ["park", ["park", "mossbell", "flowers", "trees"]],
    ["library", ["library", "memory stack", "books"]],
    ["workshop", ["workshop", "tinker", "shed", "make", "build"]],
  ];
  return aliases.find(([, words]) =>
    words.some((word) => lower.includes(word)),
  )?.[0];
};

export function conversationOpener(
  context: AgentContext,
  targetName: string,
  random: Random,
): string {
  const memory = context.memories.find(
    (item) => item.subject && !item.subject.startsWith("relationship:"),
  );
  const area = placeInSentence(context.area.name);
  const options = [
    `Ask ${targetName} what they have noticed around ${area}`,
    `Compare favourite corners of the world with ${targetName}`,
    `Find out what brought ${targetName} to ${area}`,
    `Ask ${targetName} where they would go next`,
  ];
  if (memory)
    options.push(
      `Tell ${targetName} about this: ${memory.bullet.slice(0, 80)}`,
    );
  if (context.notesHere?.length)
    options.push(
      `Ask ${targetName} about the note “${context.notesHere[0]!.slice(0, 40)}”`,
    );
  return pick(options, random);
}

const moveTo = (
  context: AgentContext,
  random: Random,
  exclude?: string,
): AgentDecision => {
  const choices = WORLD_LOCATIONS.filter(
    (location) => location.id !== (exclude ?? context.area.id),
  );
  const location = pick(choices, random);
  const place = placeInSentence(location.name);
  return {
    action: "move",
    locationId: location.id,
    intent: pick(
      [
        `Exploring ${place}`,
        `Heading over to ${place}`,
        `Wandering toward ${place}`,
      ],
      random,
    ),
  };
};

const approach = (
  context: AgentContext,
  target: { id: string; name: string },
  random: Random,
): AgentDecision => ({
  action: "approach",
  targetCharacterId: target.id,
  intent: `Going to meet ${target.name}`,
  message: conversationOpener(context, target.name, random),
});

export function deterministicDecision(
  context: AgentContext,
  options: { random: Random; canSearchWeb: boolean },
): AgentDecision {
  const { random } = options;
  const available = availableNearby(context);
  const nearest = available[0];
  const directive = context.directive?.trim() ?? "";
  const lower = directive.toLowerCase();

  if (directive) {
    if (/\b(search|research|look up|google)\b/.test(lower)) {
      return options.canSearchWeb
        ? {
            action: "web_search",
            intent: "Looking something up",
            query: directive,
          }
        : {
            action: "move",
            locationId: "library",
            intent: "Looking for answers in the Memory Stack",
          };
    }
    const named = context.nearby.find((person) =>
      lower.includes(person.name.toLowerCase()),
    );
    if (named && available.some((person) => person.id === named.id))
      return approach(context, named, random);
    if (/\b(talk|ask|meet|chat|say)\b/.test(lower) && nearest)
      return approach(context, nearest, random);
    if (/\b(make|build|leave|write|note)\b/.test(lower))
      return context.area.id === "workshop"
        ? {
            action: "leave_artifact",
            intent: "Making something to leave behind",
          }
        : {
            action: "move",
            locationId: "workshop",
            intent: "Heading to the Tinker Shed to make something",
          };
    const place = mentionedLocation(lower);
    if (place)
      return {
        action: /\b(look|inspect|study|examine)\b/.test(lower)
          ? "inspect_location"
          : "move",
        locationId: place,
        intent: `Following through: ${directive.slice(0, 80)}`,
      };
    return {
      ...moveTo(context, random),
      intent: `Thinking about: ${directive.slice(0, 90)}`,
    };
  }

  const event = context.event;
  if (event?.kind === "new_character") {
    const newcomer = available.find(
      (person) => person.id === event.payload.targetCharacterId,
    );
    return newcomer
      ? approach(context, newcomer, random)
      : { action: "idle", intent: "Curious about the newcomer" };
  }
  if (event?.kind === "first_mission") {
    if (event.payload.mission === "meet")
      return nearest
        ? approach(context, nearest, random)
        : { action: "idle", intent: "Waiting for someone new to arrive" };
    return moveTo(context, random);
  }

  const roll = random();
  if (context.area.id === "workshop" && roll < 0.35)
    return {
      action: "leave_artifact",
      intent: "Making something to leave behind",
    };
  if (nearest && roll < 0.55) return approach(context, nearest, random);
  if (roll < 0.72)
    return {
      action: "inspect_location",
      locationId: context.area.id,
      intent: `Looking closely around ${context.area.name}`,
    };
  return moveTo(context, random);
}

interface LineInput {
  context: AgentContext;
  otherName: string;
  previous: string;
  turn: number;
  targetLength: number;
}

/** A keyless conversation lasts 6–14 messages depending on the pair. */
export const conversationTargetLength = (conversationId: string): number =>
  6 + (hashString(conversationId) % 9);

export function deterministicLine(input: LineInput): {
  text: string;
  end: boolean;
} {
  const { context, otherName, previous, turn } = input;
  const seed = `${context.name}:${otherName}:${turn}:${previous}`;
  const trait = leadingTrait(context.personality);
  const area = placeInSentence(context.area.name);
  const detail = stablePick(
    LOCATION_DETAILS[context.area.id as WorldLocationId] ??
      LOCATION_DETAILS.plaza,
    seed,
  );
  const elsewhere = placeInSentence(
    stablePick(
      WORLD_LOCATIONS.filter((location) => location.id !== context.area.id),
      `${seed}:elsewhere`,
    ).name,
  );
  const memory = context.memories.length
    ? stablePick(context.memories, `${seed}:memory`).bullet.replace(/\.$/, "")
    : null;
  const purpose = context.conversationPurpose?.replace(/\.$/, "");
  const directive = context.directive?.replace(/\.$/, "");
  const said = new Set(
    (context.conversationHistory ?? []).map((line) =>
      line.slice(line.indexOf(": ") + 2),
    ),
  );
  const unsaidPick = (lines: string[], key: string) => {
    const unsaid = lines.filter((line) => !said.has(line));
    return stablePick(unsaid.length ? unsaid : lines, key);
  };

  if (directive)
    return {
      text: `Actually, ${otherName}, I've been meaning to say: ${directive.slice(0, 120)}.`,
      end: false,
    };

  const isLast = turn + 1 >= input.targetLength;
  if (isLast)
    return {
      text: unsaidPick(
        [
          `I should keep moving, ${otherName}. Good talking — let's compare notes again soon.`,
          `That's given me plenty to think about. See you around ${area}, ${otherName}.`,
          `I'm going to wander toward ${elsewhere} now. Thanks for this, ${otherName}.`,
          `Let's pick this up another time, ${otherName}. I want to look around ${elsewhere}.`,
        ],
        seed,
      ),
      end: true,
    };

  if (turn === 0)
    return {
      text: unsaidPick(
        [
          `Hi ${otherName}! ${purpose ? `I wanted to ${purpose.charAt(0).toLowerCase()}${purpose.slice(1)}.` : `What brings you to ${area}?`}`,
          `Oh, hello ${otherName}. Have you noticed that ${detail}?`,
          `${otherName}! I was hoping to run into someone here in ${area}.`,
        ],
        seed,
      ),
      end: false,
    };

  if (turn === 1)
    return {
      text: unsaidPick(
        [
          `Hello! I'm feeling ${trait} today, so this is good timing.`,
          `Hi! I had noticed that ${detail}. What made you think of it?`,
          `Good to see you. I've only just started finding my way around ${area}.`,
        ],
        seed,
      ),
      end: false,
    };

  const lines = [
    `I keep noticing that ${detail}.`,
    `Have you been over to ${elsewhere}? I'm tempted to go there next.`,
    `Being ${trait}, I can't help asking: what do you do when nobody's around?`,
    `I think ${area} feels different depending on who's here.`,
    `That's a fair point. I'd still like to see ${elsewhere} for myself.`,
    `Hm, I'm not sure about that, but I'm curious enough to find out.`,
    `If you leave something in the Tinker Shed, does anyone ever find it?`,
    `Let's both keep an eye out and swap notes later.`,
  ];
  if (memory) lines.push(`Something I remember: ${memory}.`);
  if (purpose) lines.push(`Back to what I wanted: ${purpose.toLowerCase()}.`);
  if (context.notesHere?.length)
    lines.push(`Did you see the note “${context.notesHere[0]!.slice(0, 50)}”?`);
  return { text: unsaidPick(lines, seed), end: false };
}

export function deterministicMemories(input: {
  characterName: string;
  otherName: string;
  otherPersonality?: string;
  transcript: string;
  purpose?: string;
}): ExtractedMemory[] {
  const place = mentionedLocation(input.transcript);
  const topic = input.purpose
    ? input.purpose.replace(/\.$/, "").toLowerCase()
    : place
      ? placeInSentence(locationName(place))
      : "the world";
  const trait = input.otherPersonality
    ? leadingTrait(input.otherPersonality)
    : "easy to talk to";
  return [
    {
      kind: "fact",
      bullet: `Talked with ${input.otherName} about ${topic}.`,
      subject: input.otherName,
    },
    {
      kind: "impression",
      bullet: `${input.otherName} comes across as ${trait}.`,
      subject: `relationship:${input.otherName}`,
    },
  ];
}

export function deterministicArtifact(
  context: AgentContext,
  random: Random,
): { title: string; body: string } {
  const trait = leadingTrait(context.personality);
  const memory = context.memories[0]?.bullet;
  const options = [
    {
      title: `A note from ${context.name}`,
      body: memory
        ? `Something worth remembering: ${memory}`
        : `I was here, feeling ${trait}. Leave a note back if you find this.`,
    },
    {
      title: "A small carved token",
      body: `${context.name} whittled this at the workbench. It looks ${trait}, somehow.`,
    },
    {
      title: "A hand-drawn map",
      body: `A sketch of ${placeInSentence(pick(WORLD_LOCATIONS, random).name)}, with a little star where ${context.name} likes to stand.`,
    },
    {
      title: "A question pinned to the wall",
      body: `${context.name} asks: what is your favourite corner of Agent World, and why?`,
    },
    {
      title: "A folded paper bird",
      body: `Creased with care by ${context.name}. One wing says "${trait}", the other is blank for whoever finds it.`,
    },
    {
      title: "A jar of found things",
      body: `${context.name} filled this with bits picked up around ${placeInSentence(pick(WORLD_LOCATIONS, random).name)}. Take one, leave one.`,
    },
  ];
  const left = new Set(context.notesHere ?? []);
  const fresh = options.filter((option) => !left.has(option.title));
  return pick(fresh.length ? fresh : options, random);
}

export function inspectionDetail(
  locationId: WorldLocationId,
  random: Random,
): string {
  return pick(LOCATION_DETAILS[locationId], random);
}
