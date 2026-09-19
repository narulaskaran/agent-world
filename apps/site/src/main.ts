import { mountDiorama } from "./diorama.js";

const canvas = document.querySelector<HTMLCanvasElement>("#hero-canvas");
if (canvas) mountDiorama(canvas);

const video = document.querySelector<HTMLVideoElement>("#demo-video");
const placeholder = document.querySelector<HTMLElement>("#demo-placeholder");
const source = video?.querySelector("source");
const showPlaceholder = () => {
  if (video) video.hidden = true;
  if (placeholder) placeholder.hidden = false;
};
source?.addEventListener("error", showPlaceholder);
video?.addEventListener("error", showPlaceholder);
