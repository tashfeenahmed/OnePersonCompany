import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { RecoveryBoundary } from "./components/RecoveryBoundary";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RecoveryBoundary><App /></RecoveryBoundary>
  </StrictMode>,
);
