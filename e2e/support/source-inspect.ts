import { expect, type Page } from "@playwright/test";

/** Inspect belongs to the visible source pane even while its evidence scrolls. */
export async function expectInspectInsideSource(page: Page) {
  const pane = await page.locator(".review-original").boundingBox();
  const popover = page.locator("[data-source-inspect-crop]");
  const crop = await popover.boundingBox();
  expect(pane).not.toBeNull();
  expect(crop).not.toBeNull();
  expect(crop!.x).toBeGreaterThanOrEqual(pane!.x);
  expect(crop!.y).toBeGreaterThanOrEqual(pane!.y);
  expect(crop!.x + crop!.width).toBeLessThanOrEqual(pane!.x + pane!.width);
  expect(crop!.y + crop!.height).toBeLessThanOrEqual(pane!.y + pane!.height);
  const clipping = await popover.evaluate(element => {
    const bounds = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const clipX = ["hidden", "clip", "auto", "scroll"].includes(style.overflowX);
      const clipY = ["hidden", "clip", "auto", "scroll"].includes(style.overflowY);
      if (!clipX && !clipY) continue;
      const box = parent.getBoundingClientRect();
      bounds.push({ clipX, clipY, left: box.left + parent.clientLeft, top: box.top + parent.clientTop,
        right: box.left + parent.clientLeft + parent.clientWidth, bottom: box.top + parent.clientTop + parent.clientHeight });
    }
    return bounds;
  });
  for (const bounds of clipping) {
    if (bounds.clipX) {
      expect(crop!.x).toBeGreaterThanOrEqual(bounds.left);
      expect(crop!.x + crop!.width).toBeLessThanOrEqual(bounds.right);
    }
    if (bounds.clipY) {
      expect(crop!.y).toBeGreaterThanOrEqual(bounds.top);
      expect(crop!.y + crop!.height).toBeLessThanOrEqual(bounds.bottom);
    }
  }
}
