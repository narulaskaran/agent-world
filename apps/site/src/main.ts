import { mountDiorama } from "./diorama.js";

const canvas = document.querySelector<HTMLCanvasElement>("#hero-canvas");
if (canvas) mountDiorama(canvas);

const revealed = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
  );
  revealed.forEach((el) => observer.observe(el));
} else {
  revealed.forEach((el) => el.classList.add("in"));
}

const status = document.querySelector("#copy-status");
document
  .querySelectorAll<HTMLButtonElement>("[data-copy]")
  .forEach((button) => {
    button.addEventListener("click", async () => {
      const source = document.querySelector(button.dataset.copy ?? "");
      if (!source?.textContent) return;
      try {
        await navigator.clipboard.writeText(source.textContent);
      } catch {
        return;
      }
      button.textContent = "Copied!";
      button.classList.add("done");
      if (status) status.textContent = "Commands copied to clipboard";
      setTimeout(() => {
        button.textContent = "Copy";
        button.classList.remove("done");
      }, 1800);
    });
  });
