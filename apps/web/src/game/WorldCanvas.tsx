import { useEffect, useRef, useState } from "react";
import Phaser from "phaser";
import type { PublicCharacter, WorldSnapshot } from "@agent-world/shared";
import { WORLD_HEIGHT, WORLD_WIDTH } from "@agent-world/shared";

interface Props {
  snapshot: WorldSnapshot | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

class WorldScene extends Phaser.Scene {
  snapshot: WorldSnapshot | null = null;
  selectedId: string | null = null;
  onSelect: (id: string) => void = () => {};
  onReady: () => void = () => {};
  private nodes = new Map<string, Phaser.GameObjects.Container>();
  private fountainRings: Phaser.GameObjects.Ellipse[] = [];
  private cafeGlow?: Phaser.GameObjects.Rectangle;

  constructor() {
    super("world");
  }

  preload() {
    this.load.svg("world-ground", "/assets/world/ground.svg");
    this.load.svg("world-cafe", "/assets/world/cafe.svg");
    this.load.svg("world-library", "/assets/world/library.svg");
    this.load.svg("world-fountain", "/assets/world/fountain.svg");
  }

  create() {
    this.cameras.main.setBackgroundColor("#9fc6a1");
    this.drawMap();
    this.onReady();
  }

  update(time: number) {
    this.fountainRings.forEach((ring, index) => {
      const cycle = (time / 1_400 + index / this.fountainRings.length) % 1;
      ring.setScale(0.45 + cycle * 0.75).setAlpha((1 - cycle) * 0.42);
    });
    this.cafeGlow?.setAlpha(0.1 + (Math.sin(time / 850) + 1) * 0.055);
    for (const node of this.nodes.values()) {
      node.setDepth(100 + node.y);
      const moving = node.getData("moving") === true;
      const state = String(node.getData("character-state") ?? "active");
      const speaking = node.getData("speaking") === true;
      const leftFoot = node.getByName(
        "left-foot",
      ) as Phaser.GameObjects.Rectangle | null;
      const rightFoot = node.getByName(
        "right-foot",
      ) as Phaser.GameObjects.Rectangle | null;
      const leftArm = node.getByName(
        "left-arm",
      ) as Phaser.GameObjects.Ellipse | null;
      const rightArm = node.getByName(
        "right-arm",
      ) as Phaser.GameObjects.Ellipse | null;
      if (leftFoot && rightFoot && !moving) {
        leftFoot.setPosition(-8, 18).setAngle(0);
        rightFoot.setPosition(8, 18).setAngle(0);
        leftArm?.setAngle(0);
        rightArm?.setAngle(0);
      } else if (leftFoot && rightFoot) {
        const stride = Math.sin(time / 85);
        leftFoot.setPosition(-8, 18 + stride * 4).setAngle(stride * 12);
        rightFoot.setPosition(8, 18 - stride * 4).setAngle(-stride * 12);
        leftArm?.setAngle(-stride * 18);
        rightArm?.setAngle(stride * 18);
      }

      const leftEye = node.getByName(
        "left-eye",
      ) as Phaser.GameObjects.Ellipse | null;
      const rightEye = node.getByName(
        "right-eye",
      ) as Phaser.GameObjects.Ellipse | null;
      const leftPupil = node.getByName(
        "left-pupil",
      ) as Phaser.GameObjects.Ellipse | null;
      const rightPupil = node.getByName(
        "right-pupil",
      ) as Phaser.GameObjects.Ellipse | null;
      const mouth = node.getByName(
        "mouth",
      ) as Phaser.GameObjects.Ellipse | null;
      const leftBrow = node.getByName(
        "left-brow",
      ) as Phaser.GameObjects.Rectangle | null;
      const rightBrow = node.getByName(
        "right-brow",
      ) as Phaser.GameObjects.Rectangle | null;
      const blinking =
        (time + Number(node.getData("blink-offset") ?? 0)) % 3_400 < 120;
      leftEye?.setDisplaySize(7, blinking ? 1.5 : 8);
      rightEye?.setDisplaySize(7, blinking ? 1.5 : 8);
      leftPupil?.setDisplaySize(3, blinking ? 1 : 4);
      rightPupil?.setDisplaySize(3, blinking ? 1 : 4);

      if (mouth) {
        if (speaking) {
          mouth.setDisplaySize(8, 4 + Math.abs(Math.sin(time / 105)) * 5);
        } else if (state === "sleeping" || state === "paused") {
          mouth.setDisplaySize(8, 2);
        } else {
          mouth.setDisplaySize(moving ? 7 : 10, moving ? 3 : 4);
        }
      }
      leftBrow?.setAngle(speaking ? -8 : moving ? -4 : 0);
      rightBrow?.setAngle(speaking ? 8 : moving ? 4 : 0);
    }
  }

  drawMap() {
    if (!this.snapshot) return;
    this.add.image(0, 0, "world-ground").setOrigin(0).setDepth(0);
    this.add.image(22, 28, "world-cafe").setOrigin(0).setDepth(330);
    this.cafeGlow = this.add
      .rectangle(133, 183, 92, 54, 0xffd98b, 0.14)
      .setDepth(331)
      .setBlendMode(Phaser.BlendModes.SCREEN);
    this.add.image(24, 418, "world-library").setOrigin(0).setDepth(660);
    this.add.image(497, 243, "world-fountain").setOrigin(0).setDepth(475);

    this.fountainRings = [0, 1, 2].map((index) =>
      this.add
        .ellipse(572, 330, 72, 22)
        .setStrokeStyle(2, 0xd9f4f5, 0.7)
        .setFillStyle(0xffffff, 0)
        .setDepth(474)
        .setData("ring", index),
    );

    this.addLocationSign(143, 171, "The Tiny Cup", 334);
    this.addLocationSign(145, 653, "The Memory Stack", 664);
    this.addLocationSign(572, 215, "Sunbeam Plaza", 900);
    this.addLocationSign(875, 76, "Mossbell Park", 900);
  }

  private addLocationSign(x: number, y: number, label: string, depth: number) {
    const width = label.length * 8 + 24;
    const plaque = this.add.graphics();
    plaque
      .fillStyle(0x5b4333, 0.96)
      .fillRoundedRect(-width / 2, -14, width, 28, 5);
    plaque
      .lineStyle(2, 0xd5b979, 1)
      .strokeRoundedRect(-width / 2, -14, width, 28, 5);
    const text = this.add
      .text(0, 0, label, {
        fontFamily: "'Courier New', monospace",
        fontSize: "13px",
        color: "#fff4d6",
      })
      .setOrigin(0.5);
    this.add.container(x, y, [plaque, text]).setDepth(depth);
  }

  private createCharacterNode(
    character: PublicCharacter,
  ): Phaser.GameObjects.Container {
    const container = this.add.container(character.x, character.y).setDepth(20);
    const shadow = this.add.ellipse(0, 19, 40, 14, 0x2d382d, 0.25);
    const color = Phaser.Display.Color.HexStringToColor(
      character.avatarColor,
    ).color;
    const skinTones = [
      0x78bd77, 0x6da7d9, 0xa77ac4, 0xe49a50, 0xd978a5, 0x65b8b0,
    ];
    const hairTones = [
      0x324c3c, 0x3c4770, 0x533a68, 0x70442f, 0x67384e, 0x305c5b,
    ];
    const paletteIndex =
      Math.abs(character.name.charCodeAt(0)) % skinTones.length;
    const skin = skinTones[paletteIndex] ?? 0xe8aa70;
    const hair = hairTones[paletteIndex] ?? 0x4b332c;
    const speechSide = character.name.charCodeAt(0) % 2 === 0 ? -1 : 1;
    const leftFoot = this.add
      .rectangle(-8, 18, 9, 15, 0x3f342e)
      .setName("left-foot");
    const rightFoot = this.add
      .rectangle(8, 18, 9, 15, 0x3f342e)
      .setName("right-foot");
    const leftArm = this.add
      .ellipse(-17, 2, 9, 25, skin)
      .setStrokeStyle(2, 0x4a342d)
      .setName("left-arm");
    const rightArm = this.add
      .ellipse(17, 2, 9, 25, skin)
      .setStrokeStyle(2, 0x4a342d)
      .setName("right-arm");
    const body = this.add
      .rectangle(0, 1, 28, 34, color)
      .setStrokeStyle(3, 0x2f2b2a);
    const collar = this.add.triangle(0, -10, 0, 0, 6, 7, 12, 0, 0xf5e4c3);
    const leftEar = this.add
      .ellipse(-16, -20, 7, 10, skin)
      .setStrokeStyle(2, 0x4a342d);
    const rightEar = this.add
      .ellipse(16, -20, 7, 10, skin)
      .setStrokeStyle(2, 0x4a342d);
    const head = this.add
      .ellipse(0, -20, 31, 29, skin)
      .setStrokeStyle(3, 0x2f2b2a);
    const hairCap = this.add.ellipse(0, -28, 29, 13, hair);
    const hairLock = this.add.ellipse(-10, -25, 7, 11, hair).setAngle(25);
    const leftBrow = this.add
      .rectangle(-7, -28, 8, 2, 0x3a2c27)
      .setName("left-brow");
    const rightBrow = this.add
      .rectangle(7, -28, 8, 2, 0x3a2c27)
      .setName("right-brow");
    const leftEye = this.add
      .ellipse(-7, -21, 7, 8, 0xfffbef)
      .setName("left-eye");
    const rightEye = this.add
      .ellipse(7, -21, 7, 8, 0xfffbef)
      .setName("right-eye");
    const leftPupil = this.add
      .ellipse(-7, -21, 3, 4, 0x24201d)
      .setName("left-pupil");
    const rightPupil = this.add
      .ellipse(7, -21, 3, 4, 0x24201d)
      .setName("right-pupil");
    const leftCheek = this.add.ellipse(-11, -14, 4, 3, 0xf0a0a0, 0.7);
    const rightCheek = this.add.ellipse(11, -14, 4, 3, 0xf0a0a0, 0.7);
    const mouth = this.add.ellipse(0, -13, 10, 4, 0x512b31).setName("mouth");
    const belt = this.add.rectangle(0, 8, 30, 6, 0x4a3a2a);
    const tool = this.add
      .text(0, -62, "🧰", { fontSize: "23px" })
      .setOrigin(0.5)
      .setName("tool")
      .setVisible(character.toolActive);
    const sleep = this.add
      .text(18, -54, "Zzz", {
        fontFamily: "'Courier New', monospace",
        fontSize: "14px",
        color: "#344988",
        fontStyle: "bold",
      })
      .setName("sleep")
      .setVisible(
        character.state === "sleeping" || character.state === "paused",
      );
    const stateIcon = this.add
      .text(-20, -54, "", {
        fontFamily: "'Courier New', monospace",
        fontSize: "15px",
        color: "#fff7dc",
        backgroundColor: "#4b654fcc",
        padding: { x: 5, y: 2 },
      })
      .setOrigin(0.5)
      .setName("state-icon");
    const label = this.add
      .text(0, 37, character.name, {
        fontFamily: "Inter, sans-serif",
        fontSize: "12px",
        color: "#fff8e5",
        backgroundColor: "#30483ee8",
        padding: { x: 6, y: 3 },
      })
      .setOrigin(0.5, 0)
      .setName("label");
    const intent = this.add
      .text(0, 60, character.intent, {
        fontFamily: "Inter, sans-serif",
        fontSize: "11px",
        backgroundColor: "#3f4f40d9",
        color: "#fff9e8",
        padding: { x: 6, y: 3 },
        wordWrap: { width: 150 },
        align: "center",
      })
      .setOrigin(0.5, 0)
      .setName("intent")
      .setVisible(
        character.id === this.selectedId &&
          character.state !== "talking" &&
          !character.speech,
      );
    const speech = this.add
      .text(speechSide * 36, -84, character.speech ?? "", {
        fontFamily: "Inter, sans-serif",
        fontSize: "12px",
        color: "#241f1b",
        backgroundColor: "#fff8e9ed",
        padding: { x: 9, y: 7 },
        wordWrap: { width: 190 },
        align: "center",
      })
      .setOrigin(speechSide < 0 ? 1 : 0, 1)
      .setName("speech")
      .setVisible(Boolean(character.speech));
    const selection = this.add
      .ellipse(0, 18, 50, 24)
      .setStrokeStyle(3, 0xfff5a8)
      .setName("selection")
      .setVisible(character.id === this.selectedId);
    container.add([
      shadow,
      selection,
      leftFoot,
      rightFoot,
      leftArm,
      rightArm,
      body,
      collar,
      leftEar,
      rightEar,
      head,
      hairCap,
      hairLock,
      leftBrow,
      rightBrow,
      leftEye,
      rightEye,
      leftPupil,
      rightPupil,
      leftCheek,
      rightCheek,
      mouth,
      belt,
      tool,
      sleep,
      stateIcon,
      label,
      intent,
      speech,
    ]);
    container.setData("moving", character.state === "moving");
    container.setData("character-state", character.state);
    container.setData("speaking", Boolean(character.speech));
    container.setData("blink-offset", character.name.charCodeAt(0) * 137);
    container.setSize(60, 90).setInteractive({ useHandCursor: true });
    container.on("pointerdown", () => this.onSelect(character.id));
    return container;
  }

  sync(
    snapshot: WorldSnapshot,
    selectedId: string | null,
    onSelect: (id: string) => void,
  ) {
    const first = !this.snapshot;
    this.snapshot = snapshot;
    this.selectedId = selectedId;
    this.onSelect = onSelect;
    if (first) this.drawMap();
    const liveIds = new Set(
      snapshot.characters.map((character) => character.id),
    );
    for (const [id, node] of this.nodes) {
      if (!liveIds.has(id)) {
        node.destroy(true);
        this.nodes.delete(id);
      }
    }
    for (const character of snapshot.characters) {
      let node = this.nodes.get(character.id);
      if (!node) {
        node = this.createCharacterNode(character);
        this.nodes.set(character.id, node);
      }
      node.setData("moving", character.state === "moving");
      node.setData("character-state", character.state);
      node.setData("speaking", Boolean(character.speech));
      this.tweens.killTweensOf(node);
      this.tweens.add({
        targets: node,
        x: character.x,
        y: character.y,
        duration: 900,
        ease: "Linear",
      });
      (node.getByName("tool") as Phaser.GameObjects.Text | null)?.setVisible(
        character.toolActive,
      );
      (node.getByName("sleep") as Phaser.GameObjects.Text | null)?.setVisible(
        character.state === "sleeping" || character.state === "paused",
      );
      const stateIcon = node.getByName("state-icon") as Phaser.GameObjects.Text;
      const stateSymbols: Record<string, string> = {
        waiting: "…",
        tool: "⌁",
        sleeping: "☾",
        paused: "Ⅱ",
      };
      stateIcon
        .setText(stateSymbols[character.state] ?? "")
        .setVisible(
          Boolean(stateSymbols[character.state]) && !character.toolActive,
        );
      (
        node.getByName("selection") as Phaser.GameObjects.Ellipse | null
      )?.setVisible(character.id === selectedId);
      const intent = node.getByName("intent") as Phaser.GameObjects.Text;
      intent
        .setText(character.intent)
        .setVisible(
          character.id === selectedId &&
            character.state !== "talking" &&
            !character.speech,
        );
      const speech = node.getByName("speech") as Phaser.GameObjects.Text;
      speech
        .setText(character.speech ?? "")
        .setVisible(Boolean(character.speech));
    }
  }
}

export function WorldCanvas({ snapshot, selectedId, onSelect }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const game = useRef<Phaser.Game | null>(null);
  const scene = useRef<WorldScene | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!host.current || game.current) return;
    const worldScene = new WorldScene();
    worldScene.onReady = () => setReady(true);
    scene.current = worldScene;
    game.current = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host.current,
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      pixelArt: false,
      antialias: true,
      scene: worldScene,
      transparent: false,
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    });
    return () => {
      game.current?.destroy(true);
      game.current = null;
      scene.current = null;
      setReady(false);
    };
  }, []);

  useEffect(() => {
    if (snapshot && ready && scene.current?.sys?.isActive())
      scene.current.sync(snapshot, selectedId, onSelect);
  }, [snapshot, selectedId, onSelect, ready]);

  return (
    <div
      className="world-canvas"
      ref={host}
      aria-label="Agent World shared map"
    />
  );
}
