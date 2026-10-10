// 使用实际构建产物验证 DOM 锚点和浏览器层叠；所有页面请求均返回本地合成页面。
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const source = await readFile(new URL('../dist/inkstone.user.js', import.meta.url), 'utf8')
const probe = await readFile(new URL('../docs/ui-overlay-probe.js', import.meta.url), 'utf8')
const outputDir = process.env.INKSTONE_BROWSER_OUTPUT_DIR ?? fileURLToPath(new URL('../dist/', import.meta.url))
await mkdir(outputDir, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  ...(process.env.INKSTONE_BROWSER_EXECUTABLE ? { executablePath: process.env.INKSTONE_BROWSER_EXECUTABLE } : {}),
})

const css = `body {margin:0;background:white} header {position:fixed;left:0;top:0;width:100%;height:56px;z-index:100;background:#eee}
  .actions {position:absolute;right:16px;top:10px;width:100px;height:36px} .action {position:absolute;right:16px;top:10px;width:36px;height:36px}
  .composer {position:fixed;left:260px;bottom:24px;width:760px;height:88px;padding:12px;box-sizing:border-box}
  [contenteditable] {height:50px} .hidden {display:none} #decoy-header {top:150px;width:100%;height:56px}`
const fixtures = [
  { name: 'chat-conversation', header: '<header id="page-header"><div id="conversation-header-actions" class="actions"><button>Share</button></div></header>',
    composer: '<form data-chatgpt-composer class="composer"><div data-composer-markdown contenteditable="true" role="textbox"></div></form>', headerLeft: 1164 },
  { name: 'work-conversation', header: '<header><button data-testid="share-chat-button" class="action">Share</button></header>',
    composer: '<div class="composer"><div contenteditable="true" data-lexical-editor="true" role="textbox"></div></div>', headerLeft: 1228 },
  { name: 'chat-new', header: '<header id="page-header"><button data-testid="profile-button" class="action">Profile</button></header>',
    composer: '<form data-type="unified-composer" class="composer"><div id="prompt-textarea" contenteditable="true" role="textbox"></div></form>', headerLeft: 1228 },
  { name: 'work-new', header: '<header></header>',
    composer: '<div class="composer"><div data-composer-markdown contenteditable="true" role="textbox"></div></div>', headerLeft: null },
]

async function mount(site, html, mode = 'header', viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const errors = []
  const requests = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => requests.push(request.url()))
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: `<html><head><style>${css}</style></head><body>${html}</body></html>` }))
  await page.goto(site === 'claude' ? 'https://claude.ai/new' : 'https://chatgpt.com/')
  await page.evaluate((fabPos) => localStorage.setItem('inkstone:settings', JSON.stringify({ fabPos })), mode)
  await page.addScriptTag({ content: source })
  await page.locator('[data-inkstone] .fab.in').waitFor()
  return { context, page, errors, requests }
}

async function point(page, selector) {
  const box = await page.locator(`[data-inkstone] ${selector}`).boundingBox()
  assert.ok(box)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function hit(page, position, expected) {
  const target = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    return element?.matches('[data-inkstone]') ? 'inkstone' : element?.id ?? null
  }, position)
  assert.equal(target, expected)
}

try {
  for (const viewport of [
    { width: 360, height: 740 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 1440, height: 900 },
  ]) {
    for (const fullHeader of [false, true]) {
      const run = await mount('chatgpt', fullHeader ? '<header id="page-header"></header>' :
        '<header id="page-header"><div id="conversation-header-actions" class="actions" style="right:0;width:200px;display:flex"><button>Files</button><button>Share</button><button>Profile</button></div></header>', 'header', viewport)
      const fab = await run.page.locator('[data-inkstone] .fab').boundingBox()
      assert.ok(fab && fab.x >= 0 && fab.x + fab.width <= viewport.width)
      if (fullHeader) {
        assert.equal(fab.x + fab.width, viewport.width - 8, '完整顶栏兜底必须明确使用右内边距')
      } else {
        const actions = await run.page.locator('#conversation-header-actions').boundingBox()
        assert.ok(fab.x + fab.width <= actions.x - 8, '宽动作组不能误判为完整顶栏或与导出按钮重叠')
      }
      await hit(run.page, await point(run.page, '.fab'), 'inkstone')
      await run.page.locator('[data-inkstone] .fab').click()
      assert.equal(await run.page.locator('[data-inkstone] .panel').isVisible(), true)
      const panel = await run.page.locator('[data-inkstone] .panel').boundingBox()
      assert.ok(panel && panel.x >= 16 && panel.x + panel.width <= viewport.width - 16, '顶栏导出面板不能越出视口')
      assert.ok(panel.y >= 0 && panel.y + panel.height <= viewport.height, '导出面板必须保留完整可见的操作区域')
      if (viewport.width === 360) await run.page.screenshot({ path: join(outputDir, `chatgpt-narrow-${fullHeader ? 'fallback' : 'actions'}.png`) })
      assert.deepEqual(run.errors, [])
      assert.ok(run.requests.every((url) => !url.includes('/api/')))
      await run.context.close()
      console.log(`PASS: ${viewport.width}x${viewport.height} ${fullHeader ? '完整顶栏右内边距' : '200px 动作组左侧'}，按钮无重叠且可打开面板`)
    }
  }

  for (const fixture of fixtures) {
    const run = await mount('chatgpt',
      '<div id="conversation-header-actions" class="hidden"></div><header id="decoy-header"></header>' + fixture.header + fixture.composer)
    const fab = await run.page.locator('[data-inkstone] .fab').boundingBox()
    assert.ok(fab)
    assert.ok(Math.abs(fab.x - (fixture.headerLeft == null ? 1280 - 36 - 8 : fixture.headerLeft - 44)) < 2, `${fixture.name}: 必须选中可见顶栏锚点`)
    assert.ok(fab.y >= 0 && fab.y < 56)
    await hit(run.page, await point(run.page, '.fab'), 'inkstone')
    await run.page.addStyleTag({ content: 'body > [data-inkstone] { position:static !important; z-index:1 !important; isolation:auto !important; }' })
    await hit(run.page, await point(run.page, '.fab'), 'inkstone')
    await run.page.evaluate(() => {
      const dialog = document.createElement('dialog')
      dialog.id = 'native-modal'
      dialog.style.cssText = 'position:fixed;inset:0;margin:0;width:100vw;height:100vh;max-width:none;max-height:none'
      document.body.append(dialog)
      dialog.showModal()
    })
    await hit(run.page, await point(run.page, '.fab'), 'native-modal')
    await run.page.evaluate(() => document.querySelector('#native-modal').remove())
    await run.page.locator('[data-inkstone] .fab').click()
    await run.page.locator('[data-inkstone] .adv-toggle').click()
    await run.page.locator('[data-inkstone] select[data-opt="fabPos"]').selectOption('composer')
    await run.page.locator('[data-inkstone] .fab.in').waitFor()
    const moved = await run.page.locator('[data-inkstone] .fab').boundingBox()
    assert.ok(moved.y > 730 && moved.x >= 1030, `${fixture.name}: 必须选中可见输入框容器`)
    assert.equal(await run.page.locator('[data-inkstone] .panel').isVisible(), false)
    await hit(run.page, await point(run.page, '.fab'), 'inkstone')
    await run.page.locator('[data-inkstone] .fab').click()
    await run.page.evaluate(() => history.pushState({}, '', '/c/11111111-1111-4111-8111-111111111111'))
    await run.page.locator('[data-inkstone] .panel').waitFor({ state: 'hidden' })
    const report = await run.page.evaluate(probe)
    assert.equal(report.site, 'chatgpt')
    assert.equal(report.host.style.zIndex, '2147483647')
    assert.equal(report.host.style.isolation, 'isolate')
    assert.equal(report.host.style.position, 'fixed')
    assert.equal(report.fabHitTests[0].inkstoneIsTop, true)
    assert.deepEqual(run.errors, [])
    assert.ok(run.requests.every((url) => !url.includes('/api/')), 'UI/探针不能请求 API')
    await run.context.close()
    console.log(`PASS: ${fixture.name} DOM 锚点、两种按钮位置、切换收起、URL 切页收起、顶栏层叠`)
  }

  for (const mode of ['header', 'composer']) {
    const run = await mount('claude',
      '<div id="dframe-header-actions-slot" class="actions" style="position:fixed;z-index:10"><button>Share</button></div>' +
      '<fieldset class="composer"><div data-testid="chat-input" contenteditable="true"></div></fieldset>', mode)
    await hit(run.page, await point(run.page, '.fab'), 'inkstone')
    await run.page.locator('[data-inkstone] .fab').click()
    const before = await run.page.evaluate(probe)
    assert.equal(before.host.style.position, 'static')
    assert.equal(before.host.style.zIndex, 'auto')
    assert.equal(before.host.style.isolation, 'auto')
    assert.equal(before.fab.style.zIndex, '40')
    assert.equal(before.panel.style.zIndex, '41')
    assert.equal(before.fabHitTests[0].inkstoneIsTop, true)
    await run.page.screenshot({ path: join(outputDir, `claude-${mode}-normal.png`) })
    const panelPoint = await point(run.page, '.panel')
    await run.page.evaluate(() => {
      const overlay = document.createElement('div')
      overlay.id = 'page-overlay'
      overlay.setAttribute('role', 'menu')
      overlay.style.cssText = 'position:fixed;inset:0;z-index:50;background:white'
      document.body.append(overlay)
    })
    await hit(run.page, await point(run.page, '.fab'), 'page-overlay')
    await hit(run.page, panelPoint, 'page-overlay')
    const covered = await run.page.evaluate(probe)
    assert.equal(covered.fabHitTests[0].inkstoneIsTop, false)
    assert.equal(covered.panelHitTests[0].inkstoneIsTop, false)
    assert.equal(covered.visibleOverlays.length, 1)
    await run.page.screenshot({ path: join(outputDir, `claude-${mode}-overlay.png`) })
    await run.page.evaluate(() => document.querySelector('#page-overlay').remove())
    await hit(run.page, await point(run.page, '.fab'), 'inkstone')
    await run.page.locator('[data-inkstone] .fab').click()
    assert.deepEqual(run.errors, [])
    assert.ok(run.requests.every((url) => !url.includes('/api/')))
    await run.context.close()
    console.log(`PASS: Claude ${mode} 正常可点击，z-50 页面浮层覆盖按钮和面板，关闭后恢复；诊断探针正确识别遮挡`)
  }
} finally {
  await browser.close()
}
