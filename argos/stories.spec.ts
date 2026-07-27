import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { argosScreenshot } from "@argos-ci/playwright";
import { expect, test } from "@playwright/test";

import type { Page } from "@playwright/test";

/**
 * One Playwright test per Storybook story.
 *
 * The story list and the `chromatic` parameters are both read from the static
 * Storybook build, so the review surface matches what the Chromatic workflow
 * publishes: a story that sets `delay` waits, and a story that opts out of
 * snapshots is skipped here too.
 */

type StoryEntry = {
  id: string;
  title: string;
  name: string;
  type?: string;
};

type ChromaticParameters = {
  delay?: number;
  disable?: boolean;
  disableSnapshot?: boolean;
};

const INDEX_PATH = fileURLToPath(
  new URL("../web/storybook-static/index.json", import.meta.url)
);

function readStories(): StoryEntry[] {
  const index = JSON.parse(readFileSync(INDEX_PATH, "utf8")) as {
    entries: Record<string, StoryEntry>;
  };

  return Object.values(index.entries).filter(
    (entry) => (entry.type ?? "story") === "story"
  );
}

const only = process.env.ARGOS_ONLY;
const stories = readStories().filter(
  (story) => !only || new RegExp(only).test(story.id)
);

// `title › name` is not guaranteed to be unique, and Playwright refuses two
// tests with the same title at collection time (which would produce an empty
// build). Suffix only the labels that actually collide, so names stay readable.
const labelCount = new Map<string, number>();
for (const story of stories) {
  const label = `${story.title} › ${story.name}`;
  labelCount.set(label, (labelCount.get(label) ?? 0) + 1);
}

function labelFor(story: StoryEntry): string {
  const label = `${story.title} › ${story.name}`;

  return (labelCount.get(label) ?? 0) > 1 ? `${label} (${story.id})` : label;
}

async function waitForPhase(page: Page, id: string): Promise<void> {
  // Storybook 10 exposes the active renders as an array; match by id.
  await page.waitForFunction(
    (storyId) => {
      const preview = (
        window as unknown as {
          __STORYBOOK_PREVIEW__?: {
            storyRenders?: { id: string; phase?: string }[];
          };
        }
      ).__STORYBOOK_PREVIEW__;
      const renders = preview?.storyRenders ?? [];
      const render = renders.find((item) => item.id === storyId);

      return Boolean(
        render &&
          (render.phase === "completed" ||
            render.phase === "finished" ||
            render.phase === "errored")
      );
    },
    id,
    { timeout: 60_000 }
  );
}

async function readChromaticParameters(
  page: Page,
  id: string
): Promise<ChromaticParameters | null> {
  return page.evaluate((storyId) => {
    const preview = (
      window as unknown as {
        __STORYBOOK_PREVIEW__?: {
          storyRenders?: {
            id: string;
            story?: { parameters?: { chromatic?: unknown } };
          }[];
        };
      }
    ).__STORYBOOK_PREVIEW__;
    const renders = preview?.storyRenders ?? [];
    const render = renders.find((item) => item.id === storyId);

    return (render?.story?.parameters?.chromatic ?? null) as never;
  }, id);
}

/**
 * Reports whether a `position: fixed` box larger than 100x100 is on screen.
 *
 * The dialog stories render through a MUI portal that paints over the whole
 * viewport while `#storybook-root` stays a few pixels tall, so a probe that
 * only measures the root reads those stories as empty.
 */
const HAS_OVERLAY = `
	(() => {
		return Array.from(document.querySelectorAll('*')).some((element) => {
			// Storybook's own loading and error screens are fixed wrappers of
			// their own, and are never something to capture.
			if (element.closest('.sb-wrapper')) return false;
			if (getComputedStyle(element).position !== 'fixed') return false;
			const rect = element.getBoundingClientRect();

			return rect.width > 100 && rect.height > 100;
		});
	})()
`;

function hasOverlay(page: Page): Promise<boolean> {
  return page.evaluate<boolean>(HAS_OVERLAY);
}

// A DOM that has not mounted yet is perfectly stable, so the settle loop would
// happily capture an empty page. Resolve once Storybook shows the story itself
// and either the story root has a size or a portalled overlay is on screen.
// Returns false rather than throwing, so an empty story can be skipped.
async function waitForVisible(page: Page): Promise<boolean> {
  return page
    .waitForFunction(
      `(() => {
				// While a story is being prepared, Storybook paints a skeleton in a
				// fixed wrapper: it has a size, it holds still, and it would sail
				// through both checks below. The body class is the only reliable
				// signal that the story itself is on screen.
				if (!document.body.classList.contains('sb-show-main')) return false;

				const root = document.querySelector('#storybook-root');
				const rootReady = Boolean(root && root.getBoundingClientRect().height > 0);

				return rootReady || ${HAS_OVERLAY};
			})()`,
      undefined,
      { timeout: 20_000 }
    )
    .then(() => true)
    .catch(() => false);
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);

  // Wait for the number of settled images to stop moving rather than for
  // completeness, which never arrives when a URL is deliberately broken.
  await page
    .waitForFunction(
      () => {
        const settled = Array.from(document.images).filter(
          (image) => image.complete
        ).length;
        const store = window as unknown as {
          __argosImages?: { count: number; stable: number };
        };
        const state = store.__argosImages ?? { count: -1, stable: 0 };
        store.__argosImages = state;
        state.stable = settled === state.count ? state.stable + 1 : 0;
        state.count = settled;

        return state.stable >= 3;
      },
      undefined,
      { timeout: 15_000, polling: 200 }
    )
    .catch(() => undefined);

  // Wait for animations that have an end. Infinite ones (progress bars,
  // spinners) never finish, and Argos freezes them at capture anyway.
  await page.evaluate(async () => {
    const running = document.getAnimations().filter((animation) => {
      if (animation.playState !== "running") return false;
      const timing = animation.effect?.getComputedTiming();

      return (
        typeof timing?.endTime === "number" && Number.isFinite(timing.endTime)
      );
    });

    await Promise.race([
      Promise.all(
        running.map((animation) => animation.finished.catch(() => undefined))
      ),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
  });

  // A smooth scroll is not a Web Animation and does not touch the markup, so
  // observe the offsets until they stop moving (never force them).
  await page
    .waitForFunction(
      () => {
        const sample = Array.from(document.querySelectorAll("*"))
          .filter((element) => element.scrollLeft || element.scrollTop)
          .map((element) => `${element.scrollLeft},${element.scrollTop}`)
          .join("|");
        const store = window as unknown as {
          __argosScroll?: { last: string; stable: number };
        };
        const state = store.__argosScroll ?? { last: " ", stable: 0 };
        store.__argosScroll = state;
        state.stable = sample === state.last ? state.stable + 1 : 0;
        state.last = sample;

        return state.stable >= 2;
      },
      undefined,
      { timeout: 10_000, polling: 150 }
    )
    .catch(() => undefined);

  // Sample the markup until consecutive reads match.
  await page.waitForFunction(
    () => {
      const store = window as unknown as {
        __argosMarkup?: { last: string; stable: number };
      };
      const state = store.__argosMarkup ?? { last: "", stable: 0 };
      store.__argosMarkup = state;
      const sample = document.body.innerHTML;
      state.stable = sample === state.last ? state.stable + 1 : 0;
      state.last = sample;

      return state.stable >= 3;
    },
    undefined,
    { timeout: 30_000, polling: 250 }
  );
}

async function capture(page: Page, name: string): Promise<void> {
  await settle(page);

  // Anything still busy at this point is the state the story wants to show,
  // not a load in flight.
  const staysBusy = await page.evaluate(
    () => document.querySelector('[aria-busy="true"]') !== null
  );

  const options = { stabilize: { waitForAriaBusy: !staysBusy } };

  // `#storybook-root` is the tight box of the rendered story here, including
  // under the centered layout, so framing on it keeps the diff ratio honest.
  // A story that paints from a portalled overlay leaves the root nearly empty,
  // so capture the viewport for those instead.
  const overlay = await hasOverlay(page);
  const rootHasSize = await page.evaluate(() => {
    const root = document.querySelector("#storybook-root");

    return Boolean(root && root.getBoundingClientRect().height > 0);
  });

  if (!overlay && rootHasSize) {
    await expect(page.locator("#storybook-root")).toBeVisible();
    await argosScreenshot(page, name, {
      element: "#storybook-root",
      ...options
    });

    return;
  }

  await argosScreenshot(page, name, options);
}

for (const story of stories) {
  const label = labelFor(story);

  test(label, async ({ page }) => {
    await page.goto(
      `/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story&chromatic=true`
    );
    await waitForPhase(page, story.id);

    const chromatic = await readChromaticParameters(page, story.id);
    test.skip(
      Boolean(chromatic?.disableSnapshot || chromatic?.disable),
      "Story opts out of visual snapshots"
    );

    // A story that threw during render shows Storybook's error page, and
    // capturing it would only snapshot the framework's error screen. The
    // wrapper is always in the DOM, so the signal is the body class.
    const errored = await page.evaluate(() =>
      document.body.classList.contains("sb-show-errordisplay")
    );
    test.skip(errored, "Story rendered Storybook error display");

    const visible = await waitForVisible(page);
    test.skip(!visible, "Story renders no visible content");

    if (chromatic?.delay) {
      await page.waitForTimeout(chromatic.delay);
    }

    await capture(page, label);
  });
}
