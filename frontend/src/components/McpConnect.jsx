import { useEffect, useState } from 'react'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { copyText } from '../lib/clipboard.js'
import { dateLocale } from '../lib/i18n-core.js'
import { t } from '../lib/i18n.js'
import { passwordError, ProveOwner } from './PasswordAuth.jsx'
import { Button, Row } from './ui.jsx'
import Icon from './Icon.jsx'

const ui = () => useUI.getState()
const toast = message => ui().toast(message)
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) })
const displayDate = value => {
  if (!value) return t('None')
  try { return new Date(value).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) }
  catch { return '' }
}

export function McpConnectRows() {
  return <>
    <Row icon="link" iconTint="var(--blue)" title={t('Connect MCP client')} accessory="chevron"
      onClick={() => ui().openSheet(close => <McpLinkSheet close={close} />)} />
    <Row icon="fingerprint" iconTint="var(--acc)" title={t('Connected apps')} accessory="chevron"
      onClick={() => ui().openSheet(close => <ConnectedAppsSheet close={close} />)} />
  </>
}

function McpLinkSheet({ close }) {
  const { st } = usePasskeys(true)
  const [link, setLink] = useState(null)
  const [expired, setExpired] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!link) return
    const timer = setTimeout(() => setExpired(true), Math.max(0, link.expires - Date.now()))
    return () => clearTimeout(timer)
  }, [link])
  const create = async proof => {
    setError('')
    try { setLink(await post('/api/account/mcp-link', proof)) }
    catch (e) { setError(passwordError(e)) }
  }
  const copy = async () => { if (await copyText(link.code)) toast(t('Copied')) }
  return <>
    <h3>{t('Connect MCP client')}</h3>
    {!st ? <div className="muted small">…</div> : !link ? <>
      <ProveOwner passkey={st.passkeys.length > 0} password={st.password} explain={passwordError} onProof={create} />
      {error && <div className="small" role="alert" style={{ color: 'var(--red)', marginTop: 10 }}>{error}</div>}
    </> : expired ? <>
      <div className="muted small">{t('This code has expired.')}</div>
      <div style={{ height: 12 }} />
      <Button variant="primary" onClick={() => setLink(null)}>{t('Make a new code')}</Button>
    </> : <>
      <div className="card mcp-link-code" dir="ltr">{link.code}</div>
      <div className="small muted mcp-link-expiry">{t('Expires {0}', new Date(link.expires).toLocaleTimeString(dateLocale(), { hour: 'numeric', minute: '2-digit' }))}</div>
      <Button icon="copy" onClick={copy}>{t('Copy')}</Button>
    </>}
    <div style={{ height: 8 }} />
    <Button variant="ghost" onClick={close}>{t('Done')}</Button>
  </>
}

function usePasskeys(on) {
  const [state, setState] = useState(null)
  useEffect(() => {
    if (!on) return
    let live = true
    api('/api/account/passkeys').then(value => { if (live) setState(value) }).catch(() => { if (live) setState({ passkeys: [], password: false }) })
    return () => { live = false }
  }, [on])
  return { st: state }
}

function ConnectedAppsSheet({ close }) {
  const [apps, setApps] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => api('/api/account/mcp-apps').then(r => { setApps(r.apps || []); setError('') }).catch(() => { setApps([]); setError(t('Something went wrong')) })
  useEffect(() => { load() }, [])
  const revoke = async clientId => {
    setBusy(true)
    try { await post('/api/account/mcp-apps/revoke', { client_id: clientId }); await load(); toast(t('Saved')) }
    catch { toast(t('Something went wrong')) }
    finally { setBusy(false) }
  }
  const revokeAll = async () => {
    setBusy(true)
    try { await post('/api/account/mcp-apps/revoke', { all: true }); await load(); toast(t('Saved')) }
    catch { toast(t('Something went wrong')) }
    finally { setBusy(false) }
  }
  return <>
    <h3>{t('Connected apps')}</h3>
    {apps === null ? <div className="muted small">…</div> : error ? <div className="small" role="alert">{error}</div> : !apps.length
      ? <div className="empty small">{t('No connected apps')}</div>
      : <div className="sect-b mcp-app-list">{apps.map(app => <div className="mcp-app-row" key={app.client_id}>
        <div className="mcp-app-main"><strong>{app.client_name}</strong><span className="small muted">{t('Added {0}', displayDate(app.created_at))}</span>
          <span className="small dim">{app.last_used_at ? t('Last used {0}', displayDate(app.last_used_at)) : t('None')}</span></div>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => revoke(app.client_id)}>{t('Revoke')}</Button>
      </div>)}</div>}
    {!!apps?.length && <><div style={{ height: 10 }} /><Button variant="danger" disabled={busy} onClick={revokeAll}>{t('Revoke all')}</Button></>}
    <div style={{ height: 8 }} />
    <Button variant="ghost" onClick={close}>{t('Done')}</Button>
  </>
}
