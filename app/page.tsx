import { FlowMetricsApp } from "./flowmetrics-app";

export const metadata = {
  title: "FlowMetrics — Own your energy data",
  description: "Self-hosted historical analytics for home batteries and solar systems.",
};

export default function Home() {
  return <FlowMetricsApp />;
}
