/**
 * `limkenion mcp xaa` —— 管理 XAA（SEP-990）IdP 连接。
 *
 * IdP 连接是用户级的：配置一次后，所有启用 XAA 的 MCP
 * 服务器都会复用它。它存于 settings.xaaIdp（非机密）+ 以
 * issuer 为键的钥匙串槽位（机密）。其信任域与各服务器的 AS 机密相互独立。
 */
import type { Command } from '@commander-js/extra-typings'
import { cliError, cliOk } from '../../cli/exit.js'
import {
  acquireIdpIdToken,
  clearIdpClientSecret,
  clearIdpIdToken,
  getCachedIdpIdToken,
  getIdpClientSecret,
  getXaaIdpSettings,
  issuerKey,
  saveIdpClientSecret,
  saveIdpIdTokenFromJwt,
} from '../../services/mcp/xaaIdpLogin.js'
import { errorMessage } from '../../utils/errors.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

export function registerMcpXaaIdpCommand(mcp: Command): void {
  const xaaIdp = mcp
    .command('xaa')
    .description('Manage the XAA (SEP-990) IdP connection')

  xaaIdp
    .command('setup')
    .description(
      'Configure the IdP connection (one-time setup for all XAA-enabled servers)',
    )
    .requiredOption('--issuer <url>', 'IdP issuer URL (OIDC discovery)')
    .requiredOption('--client-id <id>', "Limkenion's client_id at the IdP")
    .option(
      '--client-secret',
      'Read IdP client secret from MCP_XAA_IDP_CLIENT_SECRET env var',
    )
    .option(
      '--callback-port <port>',
      'Fixed loopback callback port (only if IdP does not honor RFC 8252 port-any matching)',
    )
    .action(options => {
      // 在任何写入之前先完成全部校验。写入中途 exit(1) 会导致
      // 设置已配置但钥匙串缺失 —— 状态令人困惑。
      // updateSettingsForSource 在写入时不做 schema 校验；非 URL 的
      // issuer 会落到磁盘上，并在下次启动时毒化整个 userSettings 来源
      // （SettingsSchema 的 .url() 失败 → parseSettingsFile
      // 返回 { settings: null }，丢弃全部内容，而不只是 xaaIdp）。
      let issuerUrl: URL
      try {
        issuerUrl = new URL(options.issuer)
      } catch {
        return cliError(
          `Error: --issuer must be a valid URL (got "${options.issuer}")`,
        )
      }
      // OIDC 发现 + 令牌交换会访问该主机。仅允许回环地址使用 http://
      // （一致性测试框架的 mock IdP）；其他情况都会以明文
      // 泄露客户端密钥和授权码。
      if (
        issuerUrl.protocol !== 'https:' &&
        !(
          issuerUrl.protocol === 'http:' &&
          (issuerUrl.hostname === 'localhost' ||
            issuerUrl.hostname === '127.0.0.1' ||
            issuerUrl.hostname === '[::1]')
        )
      ) {
        return cliError(
          `Error: --issuer must use https:// (got "${issuerUrl.protocol}//${issuerUrl.host}")`,
        )
      }
      const callbackPort = options.callbackPort
        ? parseInt(options.callbackPort, 10)
        : undefined
      // callbackPort <= 0 会在下次启动时使 Zod 的 .positive() 失败 ——
      // 与上面的 issuer 检查属于同一种设置毒化故障模式。
      if (
        callbackPort !== undefined &&
        (!Number.isInteger(callbackPort) || callbackPort <= 0)
      ) {
        return cliError('Error: --callback-port must be a positive integer')
      }
      const secret = options.clientSecret
        ? process.env.MCP_XAA_IDP_CLIENT_SECRET
        : undefined
      if (options.clientSecret && !secret) {
        return cliError(
          'Error: --client-secret requires MCP_XAA_IDP_CLIENT_SECRET env var',
        )
      }

      // 现在就读取旧配置（在设置被覆盖之前），以便在写入成功后
      // 清理失效的钥匙串槽位。`clear` 事后无法做到这一点 ——
      // 它读取的是*当前*的 settings.xaaIdp，而那时
      // 已经是新的了。
      const old = getXaaIdpSettings()
      const oldIssuer = old?.issuer
      const oldClientId = old?.clientId

      // callbackPort 必须存在（即使是 undefined）—— mergeWith 会深度合并，
      // 且仅在显式 `undefined` 时删除，而非键缺失时。使用条件
      // 展开会把之前的固定端口泄漏到新 IdP 的配置中。
      const { error } = updateSettingsForSource('userSettings', {
        xaaIdp: {
          issuer: options.issuer,
          clientId: options.clientId,
          callbackPort,
        },
      })
      if (error) {
        return cliError(`Error writing settings: ${error.message}`)
      }

      // 仅在设置写入成功后才清理失效的钥匙串槽位 ——
      // 否则写入失败会让设置仍指向 oldIssuer，
      // 而其密钥已被删除。通过 issuerKey() 比较：末尾斜杠或
      // 主机大小写差异会归一化为同一个钥匙串槽位。
      if (oldIssuer) {
        if (issuerKey(oldIssuer) !== issuerKey(options.issuer)) {
          clearIdpIdToken(oldIssuer)
          clearIdpClientSecret(oldIssuer)
        } else if (oldClientId !== options.clientId) {
          // 相同的 issuer 槽位但不同的 OAuth 客户端注册 ——
          // 缓存的 id_token 的 aud 声明与已存储的密钥都属于
          // 旧客户端。`xaa login` 会发送 {新 clientId, 旧密钥} 并
          // 以难以理解的 `invalid_client` 失败；下游 SEP-990 交换
          // 也会在 aud 校验上失败。clientId 未变时两者都保留：
          // 不带 --client-secret 重新 setup 意味着“只调端口，保留密钥”。
          clearIdpIdToken(oldIssuer)
          clearIdpClientSecret(oldIssuer)
        }
      }

      if (secret) {
        const { success, warning } = saveIdpClientSecret(options.issuer, secret)
        if (!success) {
          return cliError(
            `Error: settings written but keychain save failed${warning ? ` — ${warning}` : ''}. ` +
              `Re-run with --client-secret once keychain is available.`,
          )
        }
      }

      cliOk(`XAA IdP connection configured for ${options.issuer}`)
    })

  xaaIdp
    .command('login')
    .description(
      'Cache an IdP id_token so XAA-enabled MCP servers authenticate ' +
        'silently. Default: run the OIDC browser login. With --id-token: ' +
        'write a pre-obtained JWT directly (used by conformance/e2e tests ' +
        'where the mock IdP does not serve /authorize).',
    )
    .option(
      '--force',
      'Ignore any cached id_token and re-login (useful after IdP-side revocation)',
    )
    // TODO(paulc)：改为从 stdin 而非 argv 读取 JWT，以免它出现在
    // shell 历史中。对一致性测试无妨（docker exec 直接使用 argv，
    // 不经 shell 解析器），但真实用户会希望 `echo $TOKEN | ... --stdin`。
    .option(
      '--id-token <jwt>',
      'Write this pre-obtained id_token directly to cache, skipping the OIDC browser login',
    )
    .action(async options => {
      const idp = getXaaIdpSettings()
      if (!idp) {
        return cliError(
          "Error: no XAA IdP connection. Run 'limkenion mcp xaa setup' first.",
        )
      }

      // 直接注入路径：跳过缓存检查，跳过 OIDC。写入本身
      // 就是该操作。issuer 来自设置（唯一事实来源），而非
      // 单独的标志 —— 少一处可能不同步的地方。
      if (options.idToken) {
        const expiresAt = saveIdpIdTokenFromJwt(idp.issuer, options.idToken)
        return cliOk(
          `id_token cached for ${idp.issuer} (expires ${new Date(expiresAt).toISOString()})`,
        )
      }

      if (options.force) {
        clearIdpIdToken(idp.issuer)
      }

      const wasCached = getCachedIdpIdToken(idp.issuer) !== undefined
      if (wasCached) {
        return cliOk(
          `Already logged in to ${idp.issuer} (cached id_token still valid). Use --force to re-login.`,
        )
      }

      process.stdout.write(`Opening browser for IdP login at ${idp.issuer}…\n`)
      try {
        await acquireIdpIdToken({
          idpIssuer: idp.issuer,
          idpClientId: idp.clientId,
          idpClientSecret: getIdpClientSecret(idp.issuer),
          callbackPort: idp.callbackPort,
          onAuthorizationUrl: url => {
            process.stdout.write(
              `If the browser did not open, visit:\n  ${url}\n`,
            )
          },
        })
        cliOk(
          `Logged in. MCP servers with --xaa will now authenticate silently.`,
        )
      } catch (e) {
        cliError(`IdP login failed: ${errorMessage(e)}`)
      }
    })

  xaaIdp
    .command('show')
    .description('Show the current IdP connection config')
    .action(() => {
      const idp = getXaaIdpSettings()
      if (!idp) {
        return cliOk('No XAA IdP connection configured.')
      }
      const hasSecret = getIdpClientSecret(idp.issuer) !== undefined
      const hasIdToken = getCachedIdpIdToken(idp.issuer) !== undefined
      process.stdout.write(`Issuer:        ${idp.issuer}\n`)
      process.stdout.write(`Client ID:     ${idp.clientId}\n`)
      if (idp.callbackPort !== undefined) {
        process.stdout.write(`Callback port: ${idp.callbackPort}\n`)
      }
      process.stdout.write(
        `Client secret: ${hasSecret ? '(stored in keychain)' : '(not set — PKCE-only)'}\n`,
      )
      process.stdout.write(
        `Logged in:     ${hasIdToken ? 'yes (id_token cached)' : "no — run 'limkenion mcp xaa login'"}\n`,
      )
      cliOk()
    })

  xaaIdp
    .command('clear')
    .description('Clear the IdP connection config and cached id_token')
    .action(() => {
      // 先读取 issuer，以便清理正确的钥匙串槽位。
      const idp = getXaaIdpSettings()
      // updateSettingsForSource 使用 mergeWith：设为 undefined（而非删除）
      // 来表示移除该键。
      const { error } = updateSettingsForSource('userSettings', {
        xaaIdp: undefined,
      })
      if (error) {
        return cliError(`Error writing settings: ${error.message}`)
      }
      // 仅在设置写入成功后才清理钥匙串 —— 否则写入失败
      // 会让设置仍指向该 IdP，而其机密
      // 已被删除（与 `setup` 清理旧 issuer 的模式相同）。
      if (idp) {
        clearIdpIdToken(idp.issuer)
        clearIdpClientSecret(idp.issuer)
      }
      cliOk('XAA IdP connection cleared')
    })
}
