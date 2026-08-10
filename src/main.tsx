import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PetWindow } from "./pet/PetWindow";
import { TaskPanel } from "./panel/TaskPanel";
import "./styles.css";

const DevExpressionLab = import.meta.env.DEV
  ? lazy(() =>
      import("./pet/ExpressionLab").then(({ ExpressionLab }) => ({
        default: ExpressionLab,
      })),
    )
  : null;

const DevSupportLab = import.meta.env.DEV
  ? lazy(() =>
      import("./support/SupportLab").then(({ SupportLab }) => ({
        default: SupportLab,
      })),
    )
  : null;

const DevSupportSortBoundaryLab = import.meta.env.DEV
  ? lazy(() =>
      import("./support/SupportSortBoundaryLab").then(
        ({ SupportSortBoundaryLab }) => ({
          default: SupportSortBoundaryLab,
        }),
      ),
    )
  : null;

const DevConnectorDisconnectLab = import.meta.env.DEV
  ? lazy(() =>
      import("./panel/ConnectorDisconnectLab").then(({ ConnectorDisconnectLab }) => ({
        default: ConnectorDisconnectLab,
      })),
    )
  : null;

function Root() {
  const label =
    "__TAURI_INTERNALS__" in window
      ? getCurrentWindow().label
      : new URLSearchParams(window.location.search).get("window") ?? "panel";
  if (DevExpressionLab && label === "expression-lab") {
    return (
      <Suspense fallback={null}>
        <DevExpressionLab />
      </Suspense>
    );
  }
  if (DevSupportLab && label === "support-lab") {
    return (
      <Suspense fallback={null}>
        <DevSupportLab />
      </Suspense>
    );
  }
  if (DevSupportSortBoundaryLab && label === "support-sort-boundary-lab") {
    return (
      <Suspense fallback={null}>
        <DevSupportSortBoundaryLab />
      </Suspense>
    );
  }
  if (DevConnectorDisconnectLab && label === "connector-disconnect-lab") {
    return (
      <Suspense fallback={null}>
        <DevConnectorDisconnectLab />
      </Suspense>
    );
  }
  return label === "pet" ? <PetWindow /> : <TaskPanel />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
