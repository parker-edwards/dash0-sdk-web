import { sharedAfterEach, sharedBeforeEach } from "../shared";
import { generateUniqueId } from "../../../../src/utils";
import { browser } from "@wdio/globals";
import { loadPage, retry } from "../utils";
import { expectLogMatching, expectNoBrowserErrors } from "../expectations";
import { PAGE_VIEW_TYPE_VALUES } from "../../../../src/semantic-conventions";

describe("Start View", () => {
  beforeEach(sharedBeforeEach);
  afterEach(sharedAfterEach);

  it("transmits a page view with the given name and attributes (options object)", async () => {
    const testId = generateUniqueId(16);
    await loadPage(`/e2e/spec/08-start-view/page.html?testId=${testId}`);
    await expect(await browser.getTitle()).toMatch(/start view test/);

    const btn = await $("button=Start View Options");
    await btn.click();

    await retry(async () => {
      await expectLogMatching(
        expect.objectContaining({
          attributes: expect.arrayContaining([
            { key: "event.name", value: { stringValue: "browser.page_view" } },
            { key: "app.screen", value: { stringValue: "settings" } },
            { key: "page.load.id", value: { stringValue: expect.any(String) } },
            { key: "session.id", value: { stringValue: expect.any(String) } },
          ]),
          body: {
            kvlistValue: {
              values: expect.arrayContaining([
                { key: "type", value: { doubleValue: PAGE_VIEW_TYPE_VALUES.VIRTUAL } },
                { key: "title", value: { stringValue: "/settings" } },
              ]),
            },
          },
          severityNumber: 9,
          severityText: "INFO",
          timeUnixNano: expect.any(String),
        })
      );
    });

    expectNoBrowserErrors();
  });

  it("transmits a page view from the string shorthand", async () => {
    const testId = generateUniqueId(16);
    await loadPage(`/e2e/spec/08-start-view/page.html?testId=${testId}`);
    await expect(await browser.getTitle()).toMatch(/start view test/);

    const btn = await $("button=Start View String");
    await btn.click();

    await retry(async () => {
      await expectLogMatching(
        expect.objectContaining({
          attributes: expect.arrayContaining([{ key: "event.name", value: { stringValue: "browser.page_view" } }]),
          body: {
            kvlistValue: {
              values: expect.arrayContaining([
                { key: "type", value: { doubleValue: PAGE_VIEW_TYPE_VALUES.VIRTUAL } },
                { key: "title", value: { stringValue: "/checkout" } },
              ]),
            },
          },
          severityNumber: 9,
          severityText: "INFO",
          timeUnixNano: expect.any(String),
        })
      );
    });

    expectNoBrowserErrors();
  });
});
