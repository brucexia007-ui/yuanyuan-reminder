import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PetWindow } from "./pet/PetWindow";
import { TaskPanel } from "./panel/TaskPanel";
import "./styles.css";

function Root() {
  const label =
    "__TAURI_INTERNALS__" in window
      ? getCurrentWindow().label
      : new URLSearchParams(window.location.search).get("window") ?? "panel";
  return label === "pet" ? <PetWindow /> : <TaskPanel />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
