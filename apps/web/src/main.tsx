import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FlowMetricsApp } from "../../../app/flowmetrics-app";
import "../../../app/globals.css";

createRoot(document.getElementById("root")!).render(<StrictMode><FlowMetricsApp /></StrictMode>);
