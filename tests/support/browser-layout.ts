import { expect, type Locator } from "@playwright/test";

/** Every rendered line of a confirmation must stay beside its checkbox. */
export async function expectCheckboxTextBeside(checkbox: Locator) {
  await expect(checkbox).toBeVisible();
  const input = await checkbox.boundingBox();
  if (!input) throw new Error("Checkbox is not rendered");
  const textLines = await checkbox.locator("..").evaluate((label) => {
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    const lines: { x: number; width: number }[] = [];
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      lines.push(...Array.from(range.getClientRects(), (rect) => ({ x: rect.x, width: rect.width })));
    }
    return lines.filter((line) => line.width > 0);
  });
  expect(textLines.length).toBeGreaterThan(0);
  for (const line of textLines) expect(line.x).toBeGreaterThanOrEqual(input.x + input.width + 4);
}
