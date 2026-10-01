import { mountDiorama } from "./diorama.js";

const canvas = document.querySelector<HTMLCanvasElement>("#hero-canvas");
if (canvas) mountDiorama(canvas);
