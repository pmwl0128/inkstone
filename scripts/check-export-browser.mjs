// 实际构建产物 + Chromium + 合成 API。不会连接真实账号或站点。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { unzipSync, strFromU8 } from 'fflate'

const source = await readFile(new URL('../dist/inkstone.user.js', import.meta.url), 'utf8')
const workspaceProbe = await readFile(new URL('../docs/claude-workspace-probe.js', import.meta.url), 'utf8')
const browser = await chromium.launch({
  headless: true,
  ...(process.env.INKSTONE_BROWSER_EXECUTABLE ? { executablePath: process.env.INKSTONE_BROWSER_EXECUTABLE } : {}),
})
const id = '11111111-1111-4111-8111-111111111111'
const updated = '2026-09-30T00:00:00Z'
const personal = '22222222-2222-4222-8222-222222222222'
const team = '33333333-3333-4333-8333-333333333333'
const body = '<html><body style="margin:0;background:white"><div id="dframe-header-actions-slot" style="position:fixed;right:20px;top:12px;width:90px;height:36px"><button>Share</button></div><fieldset style="position:fixed;left:200px;right:200px;bottom:20px;height:100px"><div data-testid="chat-input" contenteditable="true"> </div></fieldset></body></html>'
const raw = {
  uuid: id, name: 'Browser regression', updated_at: updated,
  chat_messages: [{ uuid: 'message', sender: 'assistant', content: [
    { type: 'text', text: 'Body survives unavailable sandbox' },
    { type: 'tool_use', name: 'present_files', input: { filepaths: ['/mnt/user-data/outputs/report.md'] } },
  ] }],
}
const limitPaths = {
  prepare: '/api/organizations',
  list: `/api/organizations/${team}/chat_conversations`,
  detail: `/api/organizations/${team}/chat_conversations/${id}`,
  sandbox: `/api/organizations/${team}/conversations/${id}/wiggle/list-files`,
  asset: `/api/organizations/${team}/conversations/${id}/wiggle/download-file`,
}

async function setup({ cookie = true, watermark = false, assets = true, format = 'markdown', limitAt = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  if (cookie) await context.addCookies([{ name: 'lastActiveOrg', value: team, url: 'https://claude.ai' }])
  const page = await context.newPage()
  const calls = []
  const errors = []
  let sandboxAvailable = false
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (!path.startsWith('/api/')) return route.fulfill({ contentType: 'text/html', body })
    calls.push(path)
    if (path === limitPaths[limitAt]) return route.fulfill({ status: 429, headers: { 'Retry-After': '60' }, body: 'Rate limited' })
    if (path === '/api/organizations') return route.fulfill({ json: [{ uuid: personal, name: 'Personal' }, { uuid: team, name: 'Team' }] })
    assert.ok(path.startsWith(`/api/organizations/${team}/`), '每个对话/附件请求必须使用当前 team 工作区')
    if (path.endsWith('/wiggle/list-files')) return sandboxAvailable || limitAt === 'asset'
      ? route.fulfill({ json: { files_metadata: [{ path: '/mnt/user-data/outputs/report.md', size: 12 }] } })
      : route.fulfill({ status: 503, body: 'Unavailable' })
    if (path.endsWith('/wiggle/download-file')) return route.fulfill({ contentType: 'text/markdown', body: 'Final report' })
    if (path.endsWith(`/chat_conversations/${id}`)) return route.fulfill({ json: raw })
    if (path.endsWith('/chat_conversations')) return route.fulfill({ json: [{ uuid: id, name: raw.name, updated_at: updated }] })
    throw new Error(`未预期的模拟接口：${path}`)
  })
  await page.goto(`https://claude.ai/chat/${id}`)
  if (watermark) await page.evaluate(({ id, updated, format }) => {
    localStorage.setItem(`inkstone:wm:claude:${format}`, JSON.stringify({ [id]: updated }))
  }, { id, updated, format })
  await page.addScriptTag({ content: source })
  await page.locator('[data-inkstone] .fab.in').waitFor()
  await page.locator('[data-inkstone] .fab').click()
  if (!assets) {
    await page.locator('[data-inkstone] .adv-toggle').click()
    await page.locator('[data-inkstone] input[data-opt="assets"]').uncheck()
  }
  if (format === 'json') await page.locator('[data-inkstone] [data-seg="format"] button[data-v="json"]').click()
  return { context, page, calls, errors, restoreSandbox: () => { sandboxAvailable = true } }
}

async function exportAll(page) {
  await page.locator('[data-inkstone] [data-seg="scope"] button[data-v="all"]').click()
  const downloading = page.waitForEvent('download', { timeout: 45000 })
  await page.locator('[data-inkstone] .go').click()
  const download = await downloading
  const files = unzipSync(await readFile(await download.path()))
  await page.waitForFunction(() => !document.querySelector('[data-inkstone]').shadowRoot.querySelector('.go').disabled)
  return files
}

try {
  for (const limitAt of ['prepare', 'list', 'detail', 'sandbox', 'asset']) {
    const run = await setup({ limitAt })
    await run.page.locator('[data-inkstone] [data-seg="scope"] button[data-v="all"]').click()
    const began = Date.now()
    await run.page.locator('[data-inkstone] .go').click()
    await run.page.waitForFunction(() => {
      const root = document.querySelector('[data-inkstone]').shadowRoot
      return !root.querySelector('.go').disabled && root.querySelector('.status').textContent.includes('Retry-After')
    }, undefined, { timeout: 20_000 })
    const status = await run.page.locator('[data-inkstone] .status').innerText()
    assert.match(status, /安全中止/)
    assert.ok(Date.now() - began < 20_000, '不能先等待 60 秒 Retry-After 冷却')
    assert.equal(run.calls.filter((path) => path === limitPaths[limitAt]).length, 1, '全局限流响应不能触发内部重试')
    assert.equal(run.calls.at(-1), limitPaths[limitAt], '限流后不能继续请求后续接口')
    assert.deepEqual(await run.page.evaluate(() => JSON.parse(localStorage.getItem('inkstone:wm:claude:markdown') || '{}')), {})
    assert.deepEqual(run.errors, [])
    await run.context.close()
    console.log(`PASS: Claude ${limitAt} 首次 Retry-After 立即安全中止，不重试、不推进水位线`)
  }

  const run = await setup()
  const diagnostic = await run.page.evaluate(workspaceProbe)
  assert.equal(diagnostic.workspace.activeMembershipIndex, 2)
  assert.equal(diagnostic.workspace.activeIsFirst, false)
  assert.equal(diagnostic.requests.length, 3)
  assert.equal(diagnostic.requests.at(-1).status, 503)
  for (const privateValue of [id, team, personal, 'Body survives unavailable sandbox', '/mnt/user-data/outputs/report.md', 'Personal', 'Team']) {
    assert.ok(!JSON.stringify(diagnostic).includes(privateValue), '诊断报告不得包含原始账号/对话/文件值')
  }
  const first = await exportAll(run.page)
  assert.ok(Object.keys(first).some((path) => path.endsWith('.md')))
  assert.match(strFromU8(first['_failures.json']), /附件发现失败/)
  assert.match(await run.page.locator('[data-inkstone] .status').innerText(), /正文已保留.*下次增量导出重试/)
  assert.deepEqual(await run.page.evaluate(() => JSON.parse(localStorage.getItem('inkstone:wm:claude:markdown'))), {})
  run.restoreSandbox()
  const second = await exportAll(run.page)
  assert.ok(Object.keys(second).some((path) => path.includes('/attachments/') && path.endsWith('report.md')))
  assert.equal(second['_failures.json'], undefined)
  assert.deepEqual(await run.page.evaluate(() => JSON.parse(localStorage.getItem('inkstone:wm:claude:markdown'))), { [id]: updated })
  const details = run.calls.filter((path) => path.endsWith(`/chat_conversations/${id}`)).length
  await run.page.locator('[data-inkstone] .go').click()
  await run.page.waitForFunction(() => document.querySelector('[data-inkstone]').shadowRoot.querySelector('.status').textContent.startsWith('没有变化'))
  assert.equal(run.calls.filter((path) => path.endsWith(`/chat_conversations/${id}`)).length, details)
  assert.deepEqual(run.errors, [])
  await run.context.close()
  console.log('PASS: 当前组织不是第一项；503 保留正文/失败汇总；下次增量补齐文件并推进水位线；再次增量不重抓')
  console.log('PASS: 登录环境探针请求预算、活跃组织判断、503 停止和报告脱敏')

  const previous = await setup({ watermark: true })
  await previous.page.locator('[data-inkstone] [data-seg="scope"] button[data-v="all"]').click()
  await previous.page.locator('[data-inkstone] .adv-toggle').click()
  await previous.page.locator('[data-inkstone] input[data-opt="incremental"]').uncheck()
  await exportAll(previous.page)
  assert.deepEqual(await previous.page.evaluate(() => JSON.parse(localStorage.getItem('inkstone:wm:claude:markdown'))), {})
  await previous.context.close()
  console.log('PASS: 重导已有记录但发现失败时，删除旧水位线以保留后续增量重试机会')

  for (const options of [{ assets: false }, { format: 'json' }]) {
    const run = await setup(options)
    const files = await exportAll(run.page)
    assert.equal(files['_failures.json'], undefined)
    assert.deepEqual(await run.page.evaluate((format) => JSON.parse(localStorage.getItem(`inkstone:wm:claude:${format}`)), options.format ?? 'markdown'), { [id]: updated })
    assert.deepEqual(run.errors, [])
    await run.context.close()
  }
  console.log('PASS: 关闭附件或导出 JSON 时不因附件发现失败阻塞水位线')

  for (const choice of ['2', null]) {
    const run = await setup({ cookie: false })
    let dialogs = 0
    run.page.on('dialog', async (dialog) => {
      dialogs++
      if (choice === null) await dialog.dismiss()
      else await dialog.accept(choice)
    })
    if (choice === null) {
      await run.page.locator('[data-inkstone] .go').click()
      await run.page.waitForFunction(() => document.querySelector('[data-inkstone]').shadowRoot.querySelector('.status').textContent.includes('未选择 Claude 工作区'))
      assert.deepEqual(run.calls, ['/api/organizations'])
    } else {
      await exportAll(run.page)
      assert.ok(run.calls.some((path) => path.startsWith(`/api/organizations/${team}/`)))
    }
    assert.equal(dialogs, 1)
    assert.deepEqual(run.errors, [])
    await run.context.close()
  }
  console.log('PASS: 无活跃组织时显式选择；取消后不请求任何组织的对话')
} finally {
  await browser.close()
}
