// Run with Playwright and Chrome installed, passing a running workspace URL.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

async function check(baseURL) {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 750 } });
    const types = ['models', 'skills', 'knowledge', 'database'];
    const picker = type => page.locator('[data-action="resource-picker"][data-id="' + type + '"]');
    const menu = page.locator('#resource-menu');
    const buttonIds = locator => locator.evaluateAll(elements => elements.map(element => element.dataset.id));
    let lastMessage;
    await page.route('**/api/chat', route => {
      lastMessage = route.request().postDataJSON().messages.at(-1);
      return route.fulfill({ json: { model: 'test', text: '已收到。' } });
    });

    for (const path of ['#home', '#chat', '#chat/portfolio-research']) {
      await page.goto(new URL(path, baseURL).href);
      const controls = page.locator('.composer-tools [data-action="resource-picker"]');
      await controls.first().waitFor();
      assert.deepEqual(await buttonIds(controls), types);
      for (const type of types) {
        await picker(type).click();
        const tabs = menu.locator('[data-action="resource-tab"]');
        assert.deepEqual(await buttonIds(tabs), types);
        assert.equal(await menu.locator('[data-action="resource-tab"][aria-pressed="true"]').getAttribute('data-id'), type);
        await page.keyboard.press('Escape');
      }
    }

    await page.goto(new URL('#home', baseURL).href);
    await page.locator('#home-input').fill('请总结我选中的笔记');
    await page.goto(new URL('#knowledge', baseURL).href);
    const title = (await page.locator('.note-heading h2').innerText()).trim();
    await page.locator('[data-action="use-note"]').click();
    await page.waitForURL(new URL('#home', baseURL).href);
    assert.equal(await page.locator('#home-input').inputValue(), '请总结我选中的笔记');
    await page.locator('form[data-form="home"] [type="submit"]').click();
    await page.locator('.answer .formatted-text').last().waitFor();
    const reference = lastMessage.resources.find(resource => resource.kind === 'knowledge');
    assert.equal(reference.name, title);
    assert.ok(reference.text.trim());
    assert.equal(await page.locator('.message-references li').innerText(), '知识库 · ' + title);

    await page.goto(new URL('#chat', baseURL).href);
    assert.equal(await page.locator('[data-action="remove-resource"]').count(), 0);
    await page.locator('#message').fill('这是一个独立的问题');
    await page.locator('button.send-button').click();
    await page.locator('.answer .formatted-text').last().waitFor();
    assert.ok(!lastMessage.resources.some(resource => resource.kind === 'knowledge'));
  } finally {
    await browser.close();
  }
}

check(process.argv[2] || 'http://localhost:8000/').catch(error => {
  console.error(error);
  process.exitCode = 1;
});
