import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

describe("live power-flow geometry", () => {
  it("keeps label backgrounds below circular anchors", async () => {
    const css = await readFile(new URL("app/globals.css", root), "utf8");
    expect(css).toMatch(/\.flow-stage\s*\{\s*display:\s*block;\s*height:\s*235px;/);
    expect(css).toMatch(/\.flow-anchor\s*\{[\s\S]*?z-index:\s*4/);
    expect(css).toMatch(/\.flow-copy\s*\{[\s\S]*?z-index:\s*3[\s\S]*?margin:\s*30px auto 0[\s\S]*?background:\s*transparent/);
    expect(css).toMatch(/\.battery-node \.flow-copy\s*\{\s*margin-top:\s*57px/);
  });

  it("uses identical coordinates for node centers and link endpoints", async () => {
    const [css, component] = await Promise.all([
      readFile(new URL("app/globals.css", root), "utf8"),
      readFile(new URL("app/flowmetrics-app.tsx", root), "utf8"),
    ]);
    expect(css).toContain(".solar-node { left: 16.667%; top: 25%; }");
    expect(css).toContain(".battery-node { left: 50%; top: 55%; }");
    expect(css).toContain(".load-node { left: 83.333%; top: 25%; }");
    expect(css).toContain(".grid-node { left: 83.333%; top: 70%; }");
    expect(component).toContain('x1="166.67" y1="250" x2="500" y2="550"');
    expect(component).toContain('x1="500" y1="550" x2="833.33" y2="250"');
    expect(component).toContain('x1="833.33" y1="250" x2="833.33" y2="700"');
  });
});
